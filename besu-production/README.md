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

Production layout ([`../docs/production-layout.md`](../docs/production-layout.md)): 4 validators,
one per host, and 2 RPC nodes, on the two application hosts.

```
   .135: val1 + rpc1      .136: val2 + rpc2      .137: val3      .138: val4
     ▲  p2p 30303 (validators), 30304 (rpc nodes); static peers + node allowlist  ▲
     └───────────────────────────────────────────────────────────────────────────┘
  proxy, coordinators ──► HAProxy VIP 192.168.68.150:8545 ──► rpc1 (rpc2 as backup)
  chainlens (.139) ──► rpc2 :8555          Prometheus (.139) ──► :9545 / :9546 on every node
  operator ──SSH──► validator host (validator RPC on 127.0.0.1 only)
```

| Path | Used by | Purpose |
|---|---|---|
| `node/` | every Besu host | `docker-compose.yml` (`docker-compose.host.yml` for several nodes per host), `.env.example`, `validator.toml`, `rpc.toml`, `init.sh`, `start.sh`, `backup-key.sh`, `restore-key.sh`, `snapshot-chain.sh`, `restore-chain.sh`, `reset-chain.sh` |
| `operator/make-network.sh` | operator, once | genesis (QBFT validator set), `static-nodes.json`, `permissions_config.toml`, `SHA256SUMS` |
| `operator/add-node.sh` | operator, later | add a node to a **running** network (genesis untouched) |
| `operator/move-node.sh` | operator, later | a node keeps its key but gets a new IP/port (e.g. a replacement host): updates its address in the network files |
| `operator/qbft.sh` | on a validator host | validator set, add/remove votes, peers, health |
| [`../monitoring/`](../monitoring) | monitoring host | Prometheus + Grafana, dashboards and alerts for these nodes and the MPC signer |
| `firewall-example.sh` | every host | ufw rules per role (generic; for the 5-host layout with firewalld use [`../ha/firewall-layout.sh`](../ha/firewall-layout.sh)) |

## Production vs. test network

| | `besu-test-network` (test) | `besu-production` |
|---|---|---|
| Hosts | everything on one Docker host | one validator per host (.135–.138); an RPC node next to the validator on .135 and .136 |
| Node keys | committed in the repo | generated on each host, kept in its volume |
| Validator RPC | published, ADMIN/DEBUG/TRACE/PERM enabled, any host | `127.0.0.1` only, for the operator over SSH |
| Client RPC | the same nodes as the validators | dedicated RPC nodes: ETH/NET/WEB3/TXPOOL (explorer: ETH/NET/WEB3), host allowlist |
| Peering | discovery + bootnodes | **static peers + node allowlist** (permissioning), discovery off |
| Integrity | none | operator `SHA256SUMS`, verified by `start.sh` on every node |
| Prefunded accounts | well-known dev keys | only what you list in `ALLOC` (e.g. MPC `SENDER01`) |

## Sizing and topology

- **Validators:** **4**, one per host (.135, .136, .137, .138): quorum 3, so any one host can fail.
  Never put two validators on one host: losing it would halt the chain. (7 validators tolerate 2;
  with only 3 hosts, 6 validators, 2 per host, survive one host.)
  - Each: 4 vCPU, 8 GB RAM, SSD. `JAVA_OPTS=-Xmx2g` is enough at today's load (~100–200 MB of heap
    used); raise it if the *JVM heap used* panel says so.
- **RPC nodes:** **rpc1** (.135) and **rpc2** (.136) behind HAProxy on the floating IP
  `192.168.68.150:8545` (rpc1 normally, rpc2 when rpc1 is unhealthy; [`../ha/`](../ha)).
  Chainlens reads **rpc2** directly, so explorer polling stays off rpc1.
  - Each: 4–8 vCPU, 8–16 GB RAM, SSD.
- **Two nodes on one host** (.135, .136): host networking and separate ports (section *Several
  nodes on one host*): validator P2P 30303 / metrics 9545 / RPC `127.0.0.1:8645`, rpc node P2P
  30304 / metrics 9546 / RPC `<host IP>:8555` (8545 is HAProxy's port on the VIP).
- **Block period:** `BLOCK_PERIOD=2` across sites, 1 on one LAN. Set `REQUEST_TIMEOUT` to at least
  4 × the round-trip time between sites, and larger than `BLOCK_PERIOD`.

## Step by step

### 1. Hosts, network, firewall

- Linux with Docker Engine and Compose v2 on every node host; synchronized clocks (`chrony`).
- A private network between all nodes (the layout uses 192.168.68.0/24).
- Firewall: [`../ha/firewall-layout.sh`](../ha/firewall-layout.sh) applies the layout's rules with
  firewalld (or `firewall-example.sh` for ufw):

| From | To | Port |
|---|---|---|
| every Besu host (.135–.138) | every Besu node | 30303 (validators), 30304 (rpc1, rpc2) tcp + udp |
| HAProxy (.135, .136), chainlens (.139) | rpc1, rpc2 | 8555 |
| proxies, coordinators (.135, .136) | HAProxy on the VIP `.150` | 8545 |
| Prometheus (.139) | every node | 9545 (validators), 9546 (rpc nodes) |
| bastion | every host | 22 |

Validators publish JSON-RPC on `127.0.0.1` only, so their firewall opens nothing for it.

### 2. Initialise each node (on each host)

One directory per node, e.g. on .135 `/opt/besu-val1` and `/opt/besu-rpc1`:

```bash
cp -r besu-production/node /opt/besu-val1 && cd /opt/besu-val1
cp .env.example .env
```

The exact values of every node are in [`../docs/production-layout.md`](../docs/production-layout.md)
(section 2). Edit `.env`:

| Variable | Value |
|---|---|
| `BESU_IMAGE` | an exact version, e.g. `hyperledger/besu:26.11.0` |
| `BESU_ROLE` | `validator` or `rpc` |
| `NODE_NAME` | a unique name: `val1` … `val4`, `rpc1`, `rpc2` |
| `P2P_HOST`, `BIND_IP` | this host's IP, e.g. `192.168.68.135` |
| `P2P_PORT`, `METRICS_PORT`, `RPC_PORT`, `WS_PORT`, `COMPOSE_FILE` | on .135 and .136 (two nodes per host): see the layout table |

**RPC nodes** also need:

| Variable | Value |
|---|---|
| `RPC_BIND_IP` | the host's IP (`192.168.68.135` for rpc1, `.136` for rpc2) |
| `BESU_HOST_ALLOWLIST` | the names/IPs clients use in the URL: the host's IP **and the VIP** `192.168.68.150`, plus `localhost,127.0.0.1` |

Then run:

```bash
./init.sh
```

`init.sh`:
- generates the node key inside the `besu-data` volume (from the kernel's random generator);
- writes `<NODE_NAME>.json` with the **public** enode and address. Send this file to the operator.
- Back up the key now: `./backup-key.sh /secure/dir`, encrypt the file, and store it in this team's
  vault. A validator's key is its identity: if it's lost, the validator must be replaced by a vote,
  and losing two at once ends the chain.

### 3. Build the network files (operator)

```bash
CHAIN_ID=1337 BLOCK_PERIOD=1 REQUEST_TIMEOUT=2 \
ALLOC="0x<SENDER01>=1000000000000000000000000" \
  besu-production/operator/make-network.sh network/ val1.json val2.json val3.json val4.json rpc1.json rpc2.json
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

Copy the 4 files into each node directory's `network/` (e.g. `/opt/besu-val1/network/`). Compare
`SHA256SUMS` with the operator over a second channel, then start:

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

From an application host, each RPC node directly and, once HAProxy runs, through the VIP:

```bash
curl -s http://192.168.68.135:8555 -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

```bash
curl -s http://192.168.68.150:8545 -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

Then point the applications at the RPC nodes:
- proxy (.135, .136): `BESU_IP=192.168.68.150`, `BESU_PORT=8545` (HAProxy);
- coordinators: `MPC_BESU_RPC=http://192.168.68.150:8545`;
- chainlens (.139): `BESU_RPC=http://192.168.68.136:8555` (rpc2).

Add the nodes to monitoring: one line per node in `../monitoring/prometheus/targets/besu.yml` (see [`../monitoring/README.md`](../monitoring/README.md)).

## Several nodes on one host

In the layout, .135 runs val1 + rpc1 and .136 runs val2 + rpc2:

- **One directory per node**, e.g. `/opt/besu-val1` and `/opt/besu-rpc1`. The
  directory name becomes the compose project and the data volume, so the keys stay separate.
- **Host networking:** `COMPOSE_FILE=docker-compose.host.yml` in each `.env`. With Docker's bridge
  network, a node connecting to another node on the same host arrives with the Docker gateway
  address (172.x) as its source, isn't found in `permissions_config.toml`, and is dropped.
- **Different ports per node:** validator P2P 30303, metrics 9545, RPC `127.0.0.1:8645`; rpc node
  P2P 30304, metrics 9546, RPC `<host IP>:8555`. Same `P2P_HOST` and `BIND_IP` (the host's IP).
- Validator RPC stays on `127.0.0.1`, on its own port: `RPC=http://127.0.0.1:8645 operator/qbft.sh health`.
- Firewall: `../ha/firewall-layout.sh` opens both nodes' ports.

**Fault tolerance:** never put two **validators** on one host: losing it would take 2 of 4 down and
halt the chain (quorum 3). An RPC node next to a validator is fine.

## Operations

| Task | How |
|---|---|
| **Upgrade Besu** | set the new exact tag in `BESU_IMAGE` and run `./start.sh`, **one node at a time**, waiting until it is back at the chain head (`qbft.sh health`). With 4 validators, never have 2 down at once. |
| **A node gets a new IP** (same key, e.g. a replacement host) | operator: `operator/move-node.sh network/ <node>.json <new IP:port>`, copy the 4 files to every node, restart the others one at a time; start the node on the new host with `restore-key.sh`. **Never run one key on two hosts at once.** See [`../docs/disaster-recovery.md`](../docs/disaster-recovery.md), 6.1 |
| **Add an RPC node** | `init.sh` on the new host, then `operator/add-node.sh network/ rpcN.json`. Copy the 4 files to **every** node, restart nodes one at a time (`./start.sh && docker compose restart`), then start the new node. |
| **Add a validator** | same as an RPC node, then on **more than half** of the current validators run `operator/qbft.sh propose 0x<new address> true`. Once `qbft.sh validators` lists it, run `qbft.sh discard 0x<address>` on those validators. |
| **Remove a validator** | `qbft.sh propose 0x<address> false` on more than half of the validators, then `discard`. Then remove its enode from the network files with care, and redistribute. |
| **Replace a lost validator key** | start a new node (new key), vote it in, then vote the old address out |
| **A sender's transactions are not mined, while blocks continue** (proxy alert `ProxySenderStalled`; the RPC node's pool keeps growing) | the RPC node has them, the validators don't: a validator receiving a busy sender's transactions out of nonce order keeps only `tx-pool-max-future-by-sender` of them (Besu's default 200) and drops the rest, and dropped transactions are not sent again. **Fix:** restart **one** validator (`docker compose restart`): when it reconnects, it fetches the RPC node's pool. **Prevention:** `tx-pool-max-future-by-sender=2000` in every validator's `validator.toml` (the default in this package). |
| **Chain halted, then quorum came back, but no new blocks** | While quorum is lost, every validator keeps moving to higher QBFT rounds, and each round doubles its timeout (`REQUEST_TIMEOUT` × 2^round). Validators that were down restart at round 0, so after a long outage they need minutes to meet in the same round (dry run: an ~8 min outage took **8 min 20 s** to resume on its own; a 3 min outage resumed within 45 s). If no block comes within about a minute of quorum being back, **restart all validators at the same time** (`docker compose restart` on each). Their round state is in memory only, so nothing is lost; in the dry run blocks resumed **25 s** after the restart. |
| **New genesis (reset the chain)** | Besu refuses to start with *"Supplied genesis block does not match chain data stored in /data"*. Either put the original network files back, or, to really start a new chain, run `./reset-chain.sh` on **every** node (validators first). It deletes the chain data but keeps the node key, so the enodes stay valid. **Don't delete the volume**: that deletes the key too. |
| **Monitoring** | [`../monitoring/`](../monitoring): Prometheus + Grafana with a Besu production dashboard and alerts (quorum lost, no new blocks, node down, peers missing, out of sync, tx pool, heap, disk). Metrics are served on `BIND_IP:METRICS_PORT`; the compose files add `BIND_IP` to the host allowlist so Prometheus is not refused with 403. |
| **Backups** | **Keys:** `./backup-key.sh /secure/dir` on every node (once, then encrypt; losing 2 of 4 validator keys ends the chain). Restore on a rebuilt host with `./restore-key.sh <file>`. **Chain data:** `./snapshot-chain.sh /backup/chain` daily from cron on **one** node that applications don't depend on (a validator is fine: it checks all peers are connected first, then stops the node for a few minutes), with `COPY_TO=user@host:/path` for an off-site copy and `KEEP` snapshots kept. Restore onto any node of the chain with `./restore-chain.sh <archive>` (keeps that node's key; refuses another chain's snapshot). Results are published to monitoring (node-exporter textfile collector), with alerts on old, missing or failed backups. Full procedures: [`../docs/disaster-recovery.md`](../docs/disaster-recovery.md). |

## What it does not do (yet)

- **TLS on JSON-RPC.** Use the private network, or put an internal TLS proxy in front of the RPC
  nodes.
- **On-chain (contract-based) permissioning.** It uses a local allowlist file, so changing it means
  updating and restarting every node.
- **Private transactions (Paladin/Tessera).** Not included; see `besu-test-network` for the
  development setup.
