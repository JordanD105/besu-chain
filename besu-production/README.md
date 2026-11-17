# besu-production: production Hyperledger Besu (QBFT) network

This folder is the production counterpart of `../besu-test-network`, for a permissioned QBFT network:
- **validators**, one per host and failure domain, reachable only over p2p;
- **RPC nodes**, non-validating, serving the proxy, the MPC coordinator and the explorer.

Every node's key is generated **on its own host** and never leaves it. The operator only receives
public enodes and builds the network files from them.

Every step was dry-run with 4 validator hosts and 1 RPC node, each with its own IP:
- network build and start, with checksum verification;
- a transaction through the RPC node, and the RPC node refusing `admin_*`;
- one validator stopped: blocks continue. Two stopped: the chain halts. Restarted: it resumes.
- node key backup;
- **adding a 5th validator** to the running chain (new node, file update, rolling restart, vote).

```
                 private network (WireGuard / site-to-site VPN), firewall default-deny
  validator1 ◄──p2p 30303──► validator2 ◄──► validator3 ◄──► validator4     (one per site/AZ)
       ▲                                                          ▲
       └──────────────── p2p 30303 ──── rpc1, rpc2 (apps) ────────┘
                                         rpc-explorer (chainlens)
  proxy / MPC coordinator ──8545──► rpc1, rpc2        chainlens ──8545──► rpc-explorer
  Prometheus ──9545──► every node                     operator ──SSH──► validator (RPC on 127.0.0.1)
```

| Path | Used by | Purpose |
|---|---|---|
| `node/` | every Besu host | `docker-compose.yml`, `.env.example`, `validator.toml`, `rpc.toml`, `init.sh`, `start.sh`, `backup-key.sh` |
| `operator/make-network.sh` | operator, once | genesis (QBFT validator set), `static-nodes.json`, `permissions_config.toml`, `SHA256SUMS` |
| `operator/add-node.sh` | operator, later | add a node to a **running** network (genesis untouched) |
| `operator/qbft.sh` | on a validator host | validator set, add/remove votes, peers, health |
| `monitoring/prometheus.yml` | monitoring | scrape config + suggested alerts |
| `firewall-example.sh` | every host | ufw rules per role |

## Production vs. test network

| | `besu-test-network` (test) | `besu-production` |
|---|---|---|
| Hosts | everything on one Docker host | one node per host, validators in separate sites/AZs |
| Node keys | committed in the repo | generated on each host, kept in its volume |
| Validator RPC | published, ADMIN/DEBUG/TRACE/PERM enabled, any host | `127.0.0.1` only, for the operator over SSH |
| Client RPC | the same nodes as the validators | dedicated RPC nodes: ETH/NET/WEB3/TXPOOL (explorer: ETH/NET/WEB3), host allowlist |
| Peering | discovery + bootnodes | **static peers + node allowlist** (permissioning), discovery off |
| Integrity | none | operator `SHA256SUMS`, verified by `start.sh` on every node |
| Prefunded accounts | well-known dev keys | only what you list in `ALLOC` (e.g. MPC `SENDER01`) |

## Sizing and topology

- **Validators:** **4** (tolerates 1 faulty or offline validator, quorum 3) or **7** (tolerates
  2). One per failure domain: never put two validators where one outage takes both. For 3 sites
  with "survive a whole site", use **6 validators, 2 per site** (quorum 4).
  - Each: 4 vCPU, 8 GB RAM, SSD, `JAVA_OPTS=-Xmx4g`.
- **RPC nodes:**
  - **2+ for applications**, behind an internal load balancer: proxy and MPC coordinator.
  - **1 for the explorer** (`BESU_RPC_HTTP_API=ETH,NET,WEB3`), so explorer polling never slows the
    transaction path.
  - Each: 4–8 vCPU, 8–16 GB RAM, SSD.
- **Block period:** `BLOCK_PERIOD=2` across sites, 1 on one LAN. Set `REQUEST_TIMEOUT` to at least
  4 × the round-trip time between sites, and larger than `BLOCK_PERIOD`.

## Step by step

### 1. Hosts, network, firewall

- Linux with Docker Engine and Compose v2 on every node host.
- A private encrypted network between all nodes (WireGuard or a site-to-site VPN).
- Firewall rules from `firewall-example.sh`:

| From | To | Port |
|---|---|---|
| every Besu node | every Besu node | 30303/tcp + udp (p2p) |
| proxy, MPC coordinator(s) | app RPC nodes | 8545 (8546 for WebSocket) |
| chainlens | explorer RPC node | 8545 |
| Prometheus | every node | 9545 |
| each team's bastion | its own host | 22 |

Validators publish JSON-RPC on `127.0.0.1` only, so their firewall opens nothing for it.

### 2. Initialise each node (on each host)

```bash
cp -r besu-production/node /opt/besu && cd /opt/besu
cp .env.example .env
```

Edit `.env`:

| Variable | Value |
|---|---|
| `BESU_IMAGE` | an exact version, e.g. `hyperledger/besu:26.11.0` |
| `BESU_ROLE` | `validator` or `rpc` |
| `NODE_NAME` | a unique name, e.g. `validator1` |
| `P2P_HOST`, `BIND_IP` | this host's private IP |

**RPC nodes** also need:

| Variable | Value |
|---|---|
| `RPC_BIND_IP` | the private IP |
| `BESU_HOST_ALLOWLIST` | the names/IPs clients use in the URL |
| `BESU_RPC_HTTP_API` | `ETH,NET,WEB3` for the explorer node only |

Then run:

```bash
./init.sh
```

`init.sh`:
- generates the node key inside the `besu-data` volume (from the kernel's random generator);
- writes `<NODE_NAME>.json` with the **public** enode and address. Send this file to the operator.
- For a validator, back up the key now: `./backup-key.sh /secure/dir`, encrypt the file, and
  store it in this team's vault. The key is the validator's identity; if it's lost, the validator
  must be replaced by a vote.

### 3. Build the network files (operator)

```bash
CHAIN_ID=1337 BLOCK_PERIOD=2 REQUEST_TIMEOUT=4 \
ALLOC="0x<SENDER01>=1000000000000000000000000" \
  besu-production/operator/make-network.sh network/ validator1.json validator2.json validator3.json validator4.json rpc1.json rpc2.json rpc-explorer.json
```

This produces:
- `genesis.json`, with the QBFT validator set encoded by Besu (`rlp encode --type=QBFT_EXTRA_DATA`);
- `static-nodes.json`;
- `permissions_config.toml`, the node allowlist;
- `SHA256SUMS`.

The block gas limit defaults to **30,000,000** (`GAS_LIMIT=0x1c9c380`). With gas price 0, it is the
only cap on the work in one block, so keep it modest. To change it on a running chain, set
`BESU_TARGET_GAS_LIMIT` in every validator's `.env` and restart them one at a time; Besu moves the
limit toward it gradually.

`ALLOC` should contain only the accounts you really want funded, for example the MPC `SENDER01`
(see `../mpc-signer/docs/production.md`). **Keep the network files.** `genesis.json` must never
change once the chain is running.

### 4. Distribute and start (each host)

Copy the 4 files into `/opt/besu/network/`. Compare `SHA256SUMS` with the operator over a second
channel, then start:

```bash
./start.sh
```

`start.sh` refuses to start if any file is missing or doesn't match `SHA256SUMS`. Start the
validators first, then the RPC nodes.

### 5. Verify

On any validator host:

```bash
operator/qbft.sh health       # block number increasing, peer count = number of nodes - 1
operator/qbft.sh validators   # the validator set from genesis
```

From an application host:

```bash
curl -s http://<rpc1>:8545 -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

Then point the applications at the RPC nodes:
- proxy: `BESU_IP` / `BESU_PORT`;
- MPC coordinator: `MPC_BESU_RPC`;
- chainlens: `BESU_RPC` → the explorer node.

Add the nodes to Prometheus (`monitoring/prometheus.yml`).

## Operations

| Task | How |
|---|---|
| **Upgrade Besu** | set the new exact tag in `BESU_IMAGE` and run `./start.sh`, **one node at a time**, waiting until it is back at the chain head (`qbft.sh health`). With 4 validators, never have 2 down at once. |
| **Add an RPC node** | `init.sh` on the new host, then `operator/add-node.sh network/ rpcN.json`. Copy the 4 files to **every** node, restart nodes one at a time (`./start.sh && docker compose restart`), then start the new node. |
| **Add a validator** | same as an RPC node, then on **more than half** of the current validators run `operator/qbft.sh propose 0x<new address> true`. Once `qbft.sh validators` lists it, run `qbft.sh discard 0x<address>` on those validators. |
| **Remove a validator** | `qbft.sh propose 0x<address> false` on more than half of the validators, then `discard`. Then remove its enode from the network files with care, and redistribute. |
| **Replace a lost validator key** | start a new node (new key), vote it in, then vote the old address out |
| **Monitoring** | `monitoring/prometheus.yml` and Grafana dashboard 10273. Alert on: no new block for 3 × the block period; peer count below expected; a validator missing; node down; disk above 80 %. |
| **Backups** | validator keys: `backup-key.sh` (once, encrypted, per team). Chain data can be re-synced from peers; optionally snapshot an RPC node's volume to speed up adding nodes. |

## What it does not do (yet)

- **TLS on JSON-RPC.** Use the private network, or put an internal TLS proxy in front of the RPC
  nodes.
- **On-chain (contract-based) permissioning.** It uses a local allowlist file, so changing it means
  updating and restarting every node.
- **Private transactions (Paladin/Tessera).** Not included; see `besu-test-network` for the
  development setup.
