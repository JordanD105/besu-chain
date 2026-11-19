# Production layout: 5 hosts, high availability

The production deployment of this repository, host by host: what runs where, the exact settings,
the ports, the full deployment from scratch, and what survives which failure. Each component's
own guide has the details:
[`besu-production/README.md`](../besu-production/README.md),
[`mpc-signer/docs/production.md`](../mpc-signer/docs/production.md),
[`docs/proxy-with-mpc-signer.md`](proxy-with-mpc-signer.md), [`ha/README.md`](../ha/README.md),
[`monitoring/README.md`](../monitoring/README.md),
[`docs/disaster-recovery.md`](disaster-recovery.md).

![production architecture](architecture-production.png)

## 1. Hosts

The addresses in this document are the reference plan. With the Ansible deployment you can use
any others: set them in `ansible/inventory.yml` (hosts) and `ansible/group_vars/all/settings.yml`
(the two VIPs and their mask), and Ansible generates every file that contains addresses
([`../ansible/README.md`](../ansible/README.md), "The IP plan").

| Host | Runs | Role |
|---|---|---|
| **192.168.68.135** | val1, **rpc1**, **coord1**, **proxy1** (active), mpc1, HAProxy + keepalived | primary application host |
| **192.168.68.136** | val2, **rpc2**, **coord2** (warm standby), **proxy2** (standby, stopped), HAProxy + keepalived | takes over the application path when .135 fails |
| **192.168.68.137** | val3, mpc2 | validator + MPC node; daily chain snapshot |
| **192.168.68.138** | val4, mpc3 | validator + MPC node |
| **192.168.68.139** | Prometheus, Grafana, chainlens | monitoring and explorer (not on the payment path) |
| every host | node-exporter (`:9101`) | host metrics and backup results |

**Floating IPs** (keepalived, on .135 normally, .136 after a failover):

| VIP | Serves | Used by |
|---|---|---|
| `192.168.68.150` | HAProxy: `:8545` → rpc1 `:8555` (rpc2 as backup), `:9100` → coord1 (coord2 as backup) | proxies (`BESU_IP`, `WEB3SIGNER_IP`, `MPC_ADMIN_URL`), coordinators (`MPC_BESU_RPC`) |
| `192.168.68.151` | `:30000` → the active proxy | applications, Prometheus (proxy job) |

```
                applications ──► 192.168.68.151:30000 (proxy VIP)
                                       │
                 ┌─────────────────────┴───────────────────────┐
     ┌── .135 ───┴──────────────┐              ┌── .136 ───────┴───────────┐
     │ proxy1 (active)          │              │ proxy2 (stopped: standby) │
     │ HAProxy ◄── VIP .150 ──► │◄── keepalived ──►│ HAProxy               │
     │   :8545 → rpc1|rpc2 :8555│              │                           │
     │   :9100 → coord1 | coord2│              │                           │
     │ rpc1  coord1  val1  mpc1 │              │ rpc2  coord2  val2        │
     └──────────────────────────┘              └───────────────────────────┘
     ┌── .137 ──────┐  ┌── .138 ──────┐  ┌── .139 ─────────────────────────┐
     │ val3  mpc2   │  │ val4  mpc3   │  │ Prometheus  Grafana  chainlens  │
     └──────────────┘  └──────────────┘  │ (chainlens reads rpc2)          │
                                         └─────────────────────────────────┘
     QBFT: 4 validators, quorum 3 · MPC: 3 nodes, threshold 2 · one of each per host (.135–.138)
```

## 2. Settings per component

### Besu nodes (`besu-production/node`, one directory per node)

| Node | Host | Directory (example) | `BESU_ROLE` | `P2P_PORT` | `METRICS_PORT` | `RPC_BIND_IP:RPC_PORT` | `WS_PORT` | `COMPOSE_FILE` |
|---|---|---|---|---|---|---|---|---|
| val1 | .135 | `/opt/besu-val1` | validator | 30303 | 9545 | `127.0.0.1:8645` | 8646 | `docker-compose.host.yml` |
| rpc1 | .135 | `/opt/besu-rpc1` | rpc | 30304 | 9546 | `192.168.68.135:8555` | 8546 | `docker-compose.host.yml` |
| val2 | .136 | `/opt/besu-val2` | validator | 30303 | 9545 | `127.0.0.1:8645` | 8646 | `docker-compose.host.yml` |
| rpc2 | .136 | `/opt/besu-rpc2` | rpc | 30304 | 9546 | `192.168.68.136:8555` | 8546 | `docker-compose.host.yml` |
| val3 | .137 | `/opt/besu-val3` | validator | 30303 | 9545 | `127.0.0.1:8545` | 8546 | default |
| val4 | .138 | `/opt/besu-val4` | validator | 30303 | 9545 | `127.0.0.1:8545` | 8546 | default |

Every node: `NODE_NAME` = the node's name, `P2P_HOST` and `BIND_IP` = its host's IP.
The RPC nodes listen on **8555**, not 8545: HAProxy holds 8545 on the VIP `.150` on the same hosts,
and Besu refuses to start when its port is taken on any address of the host (after a reboot,
HAProxy starts first). Clients always use the VIP `192.168.68.150:8545`.
`BESU_HOST_ALLOWLIST` on the RPC nodes:

- rpc1: `192.168.68.135,192.168.68.150,localhost,127.0.0.1`
- rpc2: `192.168.68.136,192.168.68.150,localhost,127.0.0.1` (chainlens calls it on `.136`)

Validators: `tx-pool-max-future-by-sender=2000` (in `validator.toml`). Two nodes on one host need
host networking (`docker-compose.host.yml`), so they can peer with each other.

### MPC (`mpc-signer/deploy`)

| Component | Host | Settings |
|---|---|---|
| mpc1 | .135 | `MPC_NODE_ID=0`, `MPC_BIND_IP=192.168.68.135`, port 7000 |
| mpc2 | .137 | `MPC_NODE_ID=1`, `MPC_BIND_IP=192.168.68.137` |
| mpc3 | .138 | `MPC_NODE_ID=2`, `MPC_BIND_IP=192.168.68.138` |
| `cluster.json` | everywhere | urls `http://192.168.68.135:7000`, `…137:7000`, `…138:7000` (`deploy/cluster.example.json`); identical on all nodes and coordinators |
| coord1 | .135 | `MPC_BIND_IP=192.168.68.135`, `MPC_RELAY_URL=ws://192.168.68.135:9100/relay`, `MPC_BESU_RPC=http://192.168.68.150:8545` |
| coord2 | .136 | `MPC_BIND_IP=192.168.68.136`, `MPC_RELAY_URL=ws://192.168.68.136:9100/relay`, `MPC_BESU_RPC=http://192.168.68.150:8545` |

Both coordinators: the same tokens (`MPC_NODE_TOKEN`, `MPC_ADMIN_TOKEN`, `MPC_METRICS_TOKEN`),
`MPC_POOL_KEYS=<SENDER01>`. Both run all the time: HAProxy sends requests to coord1, and coord2
keeps its own presignature pool full, ready to take over. A coordinator re-reads the key list from
the MPC nodes when it meets an account it doesn't know, for `eth_accounts`, and every 30 s, so an
account created through one coordinator signs at once through the other. It needs only 2 of the 3
nodes to start.

Each MPC node keeps being run by its **own team** (one per host .135, .137, .138); no person or
storage holds two shares.

### Proxy (`proxy/`, on .135 and .136)

Same `.env` on both (`proxy/.env.example`): `BESU_IP=192.168.68.150`, `WEB3SIGNER_IP=192.168.68.150`
(port 9100), `MPC_ADMIN_URL=http://192.168.68.150:9100`, `SENDER01`, `MPC_ADMIN_TOKEN`. Only the
host holding `192.168.68.151` runs it: keepalived starts and stops it (`ha/proxy-start.sh`,
`ha/proxy-stop.sh`). A starting proxy takes its nonces from the chain, so a failover needs no state.

### HAProxy and keepalived (.135, .136)

`ha/haproxy.cfg` (identical on both), `ha/keepalived-135.conf` / `ha/keepalived-136.conf`, and the
three scripts. Steps: [`ha/README.md`](../ha/README.md).

### Chainlens and monitoring (.139)

- chainlens: `BESU_RPC=http://192.168.68.136:8555` (rpc2, so explorer polling stays off rpc1).
- monitoring: `BIND_IP=192.168.68.139`; the target files in `monitoring/prometheus/targets/` are set
  for this layout (6 Besu nodes, coord1 and coord2 on their own IPs, the proxy on its VIP, 5 hosts).

## 3. Ports and firewall

`ha/firewall-layout.sh` applies these rules with firewalld on each host
(`CLIENTS="…" ADMIN=… ./firewall-layout.sh 135`):

| Port | On | From |
|---|---|---|
| 30303, 30304 tcp+udp | Besu p2p on .135–.138 | the other Besu hosts |
| 9545, 9546 | Besu metrics | .139 |
| 8545 | HAProxy on the VIP `.150` | .135, .136 (proxies, coordinators), admin |
| 8555 | rpc1 / rpc2 | .135, .136 (HAProxy), .139 (chainlens), admin |
| 9100 | coord1 / coord2 (and the VIP `.150`) | .135, .136, the MPC nodes (relay), .139 (metrics), admin |
| 7000 | mpc1 / mpc2 / mpc3 | .135, .136 (coordinators) |
| 30000 | proxy (and the VIP `.151`) | application clients, .139, admin |
| VRRP (protocol 112) | .135 ↔ .136 | each other |
| 9101 | node-exporter on every host | .139 |
| 3000, 30100 | Grafana, chainlens on .139 | admin; clients for chainlens |
| 22 | every host | admin / bastion |

**Ports published by Docker bypass firewalld.** The proxy, coordinators, MPC nodes, Grafana,
chainlens, Redis and the Besu nodes without host networking are reached through Docker's port
forwarding (DNAT, then the FORWARD chain), which firewalld's zone rules never see: without more, any
host on the network could connect to them. `firewall-layout.sh` therefore applies the same allow list
to forwarded connections as well, in an nftables table of its own (`inet besu_docker`, installed with
the systemd unit `besu-docker-firewall`, applied at every boot): the listed sources reach the
listed ports, every other new connection to a published port is dropped. Docker and firewalld never
touch that table, so neither a Docker restart nor `firewall-cmd --reload` opens a gap (Docker's own
`DOCKER-USER` chain is not used because Docker re-orders its jumps for a few seconds on every
firewalld reload). Check it:

```bash
nft list table inet besu_docker
```

From a host that is **not** in the list, every published port must time out, e.g.
`timeout 3 bash -c '</dev/tcp/<host>/9100' || echo blocked`.

## 4. Deploying from scratch

A new chain and a new MPC cluster on five empty hosts. **Automated:** [`ansible/`](../ansible/README.md)
runs all of this except the MPC nodes, which their teams run (it stops and tells you when). By hand,
do the steps **in this order**: the genesis
needs `SENDER01` (MPC key ceremony), HAProxy needs the RPC nodes, and keepalived needs the proxy.

| Step | Where | What |
|---|---|---|
| [4.1](#41-prepare-every-host) | .135–.139 | Docker, clock, repository, firewall, node-exporter |
| [4.2](#42-mpc-image-and-tokens-operator) | operator | build the MPC image, generate the tokens |
| [4.3](#43-mpc-nodes-135-137-138) | .135, .137, .138 | mpc1, mpc2, mpc3 (each by its own team) |
| [4.4](#44-clusterjson-operator) | operator | `cluster.json`, then start the 3 MPC nodes |
| [4.5](#45-coordinators-and-key-ceremony-135-136) | .135, .136 | coord1, coord2, key ceremony → `SENDER01` |
| [4.6](#46-besu-node-keys-135-138) | .135–.138 | the 6 Besu nodes: keys |
| [4.7](#47-besu-network-files-operator) | operator | genesis and network files (`SENDER01` funded) |
| [4.8](#48-start-besu-135-138) | .135–.138 | validators, then the RPC nodes |
| [4.9](#49-proxy-135-136) | .135, .136 | build the proxy (not started) |
| [4.10](#410-haproxy-and-keepalived-135-136) | .135, .136 | HAProxy, keepalived: VIPs up, proxy1 starts |
| [4.11](#411-check-the-application-path) | any | test account and transfer through the VIPs |
| [4.12](#412-monitoring-and-chainlens-139) | .139 | Prometheus, Grafana, chainlens |
| [4.13](#413-backups) | .135–.138 | key backups, MPC backups, daily chain snapshot |
| [4.14](#414-failover-tests-then-go-live) | — | the failover tests of section 6, then go live |

The **operator** machine is the bastion (or .139): it needs Docker and a clone of this repository.
It only handles public files and the shared tokens; no Besu key or MPC share ever goes there.
All commands below run as root (or with `sudo`).

### 4.1 Prepare every host

On **each** of .135, .136, .137, .138, .139:

1. Docker Engine and the Compose plugin (Docker's instructions for your distribution), plus:

   ```bash
   dnf install -y git chrony firewalld && systemctl enable --now docker chronyd firewalld
   ```

   `chronyc tracking` must show a synchronized clock (QBFT and the alerts depend on it).
2. The repository, at the same path on every host (the keepalived scripts use it):

   ```bash
   git clone https://github.com/JordanD105/besu-chain.git /opt/besu-chain
   ```

   (with a deploy key or token if the repository is private).

3. Firewall, with that host's last number (`135` … `139`):

   ```bash
   CLIENTS="<application IPs>" ADMIN=<bastion IP> /opt/besu-chain/ha/firewall-layout.sh 135
   ```

4. node-exporter, with that host's IP:

   ```bash
   cd /opt/besu-chain/monitoring/node-exporter && echo BIND_IP=192.168.68.135 > .env && docker compose up -d
   ```

### 4.2 MPC image and tokens (operator)

```bash
cd /opt/besu-chain/mpc-signer
docker build --build-arg BIGINT=bigint-rug -t registry.example.com/mpc-signer:1.3.0 .
docker push registry.example.com/mpc-signer:1.3.0
```

Without a registry, copy it to the four hosts that run MPC components:

```bash
for h in 135 136 137 138; do docker save registry.example.com/mpc-signer:1.3.0 | ssh root@192.168.68.$h docker load; done
```

Generate the three shared tokens (hand them over through each team's secret channel, never chat
or email):

```bash
openssl rand -hex 32    # MPC_NODE_TOKEN    : the 3 MPC nodes and both coordinators
openssl rand -hex 32    # MPC_ADMIN_TOKEN   : both coordinators, the operator, both proxies
openssl rand -hex 32    # MPC_METRICS_TOKEN : both coordinators and the monitoring host
```

### 4.3 MPC nodes (.135, .137, .138)

Each node by **its own team**, on its own host:

| Node | Host | `MPC_NODE_ID` | `MPC_BIND_IP` |
|---|---|---|---|
| mpc1 | .135 | 0 | `192.168.68.135` |
| mpc2 | .137 | 1 | `192.168.68.137` |
| mpc3 | .138 | 2 | `192.168.68.138` |

```bash
cp -r /opt/besu-chain/mpc-signer/deploy/node /opt/mpc-node && cd /opt/mpc-node
cp .env.example .env && chmod 600 .env
```

In `.env`: `MPC_IMAGE=registry.example.com/mpc-signer:1.3.0`, `MPC_NODE_ID` and `MPC_BIND_IP`
from the table, `MPC_NODE_TOKEN`, `MPC_COMPUTE_THREADS` = about the host's core count. Then:

```bash
./init.sh
```

It generates this node's `MPC_NODE_PASSPHRASE` into `.env`: **store it in this team's vault now**
(without it, the share and its backups can't be opened). Send `node<ID>.json` (public keys only)
to the operator. Don't start the node yet.

### 4.4 `cluster.json` (operator)

```bash
cd /opt/besu-chain/mpc-signer/deploy
CHAIN_ID=1337 MAX_VALUE_WEI=1000000000000000000000 MAX_GAS=30000000 \
  ./make-cluster.sh node0.json node1.json node2.json > cluster.json
sha256sum cluster.json
```

Leave `ALLOWED_TO` empty (the proxy creates accounts and deploys contracts). Copy `cluster.json`
to `/opt/mpc-node/` on .135, .137, .138 and to the operator's coordinator copies below; every team
compares the `sha256sum`. Then each MPC team starts its node:

```bash
cd /opt/mpc-node && docker compose up -d && docker compose logs --tail 5
```

Expect `node loaded` and `node API listening`.

### 4.5 Coordinators and key ceremony (.135, .136)

On .135 (coord1) and .136 (coord2):

```bash
cp -r /opt/besu-chain/mpc-signer/deploy/coordinator /opt/mpc-coordinator && cd /opt/mpc-coordinator
cp .env.example .env && chmod 600 .env
```

| Setting | coord1 (.135) | coord2 (.136) |
|---|---|---|
| `MPC_IMAGE` | `registry.example.com/mpc-signer:1.3.0` | same |
| `MPC_BIND_IP` | `192.168.68.135` | `192.168.68.136` |
| `MPC_RELAY_URL` | `ws://192.168.68.135:9100/relay` | `ws://192.168.68.136:9100/relay` |
| `MPC_BESU_RPC` | `http://192.168.68.150:8545` | same |
| `MPC_NODE_TOKEN`, `MPC_ADMIN_TOKEN`, `MPC_METRICS_TOKEN` | from 4.2 | same |
| `MPC_POOL_KEYS` | empty for now | empty for now |

Copy `cluster.json` next to `docker-compose.yml`, then:

```bash
docker compose up -d && docker compose logs --tail 5
```

Expect `keys loaded from nodes keys=0`. `MPC_BESU_RPC` points at the VIP, which comes up in 4.10:
until then the coordinators can't reach Besu, which is fine (nothing to send yet).

**Key ceremony** (operator, all 3 MPC nodes up), directly against coord1:

```bash
COORD=http://192.168.68.135:9100 ADMIN_TOKEN=<MPC_ADMIN_TOKEN> /opt/besu-chain/mpc-signer/deploy/ceremony.sh
```

Aux info takes 1–3 minutes, then the distributed key generation prints the first address: that is
**`SENDER01`**. Write it down: the genesis funds it (4.7) and the proxy uses it (4.9).

On **both** coordinators set `MPC_POOL_KEYS=<SENDER01>` in `.env`, then `docker compose up -d`.
Check that each fills its pool (`"pooled": true`, `ready` climbing):

```bash
curl -s -H "Authorization: Bearer <MPC_ADMIN_TOKEN>" http://192.168.68.135:9100/admin/pool
curl -s -H "Authorization: Bearer <MPC_ADMIN_TOKEN>" http://192.168.68.136:9100/admin/pool
```

### 4.6 Besu node keys (.135–.138)

One directory per node, with the values of section 2:

| Host | Directories |
|---|---|
| .135 | `/opt/besu-val1`, `/opt/besu-rpc1` |
| .136 | `/opt/besu-val2`, `/opt/besu-rpc2` |
| .137 | `/opt/besu-val3` |
| .138 | `/opt/besu-val4` |

For each node (example: val1):

```bash
cp -r /opt/besu-chain/besu-production/node /opt/besu-val1 && cd /opt/besu-val1
cp .env.example .env && chmod 600 .env
```

`.env` of **val1** (.135):

```bash
BESU_IMAGE=hyperledger/besu:26.11.1
BESU_ROLE=validator
NODE_NAME=val1
P2P_HOST=192.168.68.135
BIND_IP=192.168.68.135
P2P_PORT=30303
METRICS_PORT=9545
RPC_BIND_IP=127.0.0.1
RPC_PORT=8645
WS_PORT=8646
JAVA_OPTS=-Xmx4g
COMPOSE_FILE=docker-compose.host.yml
```

`.env` of **rpc1** (.135):

```bash
BESU_IMAGE=hyperledger/besu:26.11.1
BESU_ROLE=rpc
NODE_NAME=rpc1
P2P_HOST=192.168.68.135
BIND_IP=192.168.68.135
P2P_PORT=30304
METRICS_PORT=9546
RPC_BIND_IP=192.168.68.135
RPC_PORT=8555
WS_PORT=8546
JAVA_OPTS=-Xmx4g
COMPOSE_FILE=docker-compose.host.yml
BESU_HOST_ALLOWLIST=192.168.68.135,192.168.68.150,localhost,127.0.0.1
BESU_RPC_HTTP_API=ETH,NET,WEB3,TXPOOL
BESU_RPC_WS_API=ETH,NET,WEB3,TXPOOL
```

- **val2 / rpc2** (.136): the same as val1 / rpc1 with `192.168.68.136` everywhere and
  `NODE_NAME=val2` / `rpc2` (rpc2's allowlist: `192.168.68.136,192.168.68.150,localhost,127.0.0.1`).
- **val3** (.137) / **val4** (.138): like val1 with their own IP and name, `RPC_PORT=8545`,
  `WS_PORT=8546`, and **no** `COMPOSE_FILE` line (one node on the host: default networking).

Then, in each directory:

```bash
./init.sh
```

It creates the node key inside the data volume (it never leaves the host) and writes
`<NODE_NAME>.json` (public enode and address). Send the six files `val1.json` … `val4.json`,
`rpc1.json`, `rpc2.json` to the operator.

### 4.7 Besu network files (operator)

```bash
cd /opt/besu-chain/besu-production/operator
CHAIN_ID=1337 BLOCK_PERIOD=1 REQUEST_TIMEOUT=2 \
ALLOC="<SENDER01>=1000000000000000000000000" \
  ./make-network.sh network/ val1.json val2.json val3.json val4.json rpc1.json rpc2.json
cat network/SHA256SUMS
```

- `CHAIN_ID` must be the one in `cluster.json` (4.4).
- `ALLOC` funds `SENDER01` in the genesis (here 1,000,000 ETH, in wei).
- `BLOCK_PERIOD=1` and `REQUEST_TIMEOUT=2` suit hosts on one LAN.

Copy the 4 files of `network/` (`genesis.json`, `static-nodes.json`, `permissions_config.toml`,
`SHA256SUMS`) into the `network/` directory of **all six** node directories. Each team compares
`SHA256SUMS` with the operator over a second channel. Keep a copy of `network/` in a safe place
(section 4.13).

### 4.8 Start Besu (.135–.138)

Validators first, in their directories: `/opt/besu-val1` (.135), `/opt/besu-val2` (.136),
`/opt/besu-val3` (.137), `/opt/besu-val4` (.138):

```bash
./start.sh
```

Blocks start once at least 3 validators are up. Check on .135 (on .137/.138 without `RPC=`,
port 8545):

```bash
RPC=http://127.0.0.1:8645 /opt/besu-chain/besu-production/operator/qbft.sh health
```

Expect the block number rising and 5 peers. Then the RPC nodes, `/opt/besu-rpc1` (.135) and
`/opt/besu-rpc2` (.136), with `./start.sh`, and check each one:

```bash
curl -s http://192.168.68.135:8555 -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_syncing","params":[]}'
```

Expect `"result":false` (in sync); `.136` for rpc2.

### 4.9 Proxy (.135, .136)

On both hosts, the same `.env`:

```bash
cd /opt/besu-chain/proxy && cp .env.example .env && chmod 600 .env
```

In `.env`: `SENDER01=<SENDER01>` and `MPC_ADMIN_TOKEN`; the VIP addresses are already set
(`BESU_IP`/`WEB3SIGNER_IP=192.168.68.150`, `MPC_ADMIN_URL=http://192.168.68.150:9100`). Build
the image, but **don't start** it: keepalived does that on the host holding `.151`.

```bash
docker compose build
```

### 4.10 HAProxy and keepalived (.135, .136)

Follow [`ha/README.md`](../ha/README.md), sections 1, 3 and 4: `ip_nonlocal_bind`, SELinux,
`haproxy.cfg`, then keepalived (`INTERFACE`, the two `auth_pass` values, `PROXY_DIR=/opt/besu-chain/proxy`).
Start keepalived on **.135 first**, then on .136. Check on .135:

```bash
ip -br addr | grep -E '68\.15[01]/'
```

Both VIPs are on .135, and keepalived started proxy1 (`docker ps` shows the proxy;
`journalctl -t besu-ha`). .136 holds no VIP and its proxy is stopped.

### 4.11 Check the application path

From an application host:

```bash
curl -s http://192.168.68.150:8545 -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
curl -s http://192.168.68.151:30000/status/senders
curl -s -X POST http://192.168.68.151:30000/createaccount -H 'content-type: application/json' --data '{"amount":"1"}'
```

The last call creates an MPC account and funds it from `SENDER01`. Then send a transfer with
`POST /transfer` (`from`, `to`, `amount`) and the NFT calls you use
([`proxy/api.txt`](../proxy/api.txt), [`docs/proxy-with-mpc-signer.md`](proxy-with-mpc-signer.md)).

### 4.12 Monitoring and chainlens (.139)

```bash
cp -r /opt/besu-chain/monitoring /opt/monitoring && cd /opt/monitoring
MPC_METRICS_TOKEN=<MPC_METRICS_TOKEN> ./setup.sh
```

`setup.sh` prints the Grafana admin password once. In `.env` set `BIND_IP=192.168.68.139`. The
targets in `prometheus/targets/` already match this layout. Start and check every target:

```bash
docker compose up -d && ./check-targets.sh
```

Grafana: `http://192.168.68.139:3000`. Chainlens, reading rpc2:

```bash
cd /opt/besu-chain/chainlens && cp .env.example .env
sed -i 's|^BESU_RPC=.*|BESU_RPC=http://192.168.68.136:8555|' .env && docker compose up -d --build
```

Explorer: `http://192.168.68.139:30100`.

### 4.13 Backups

| What | Where | How |
|---|---|---|
| Besu node keys | all 6 node directories | once: `./backup-key.sh /secure/dir`, then `gpg --symmetric` and delete the plain copy |
| MPC shares | `/opt/mpc-node` on .135, .137, .138 (each team) | cron, hourly: `0 * * * * /opt/mpc-node/backup.sh /secure/backup` |
| Chain snapshot | `/opt/besu-val3` on .137 | cron, daily: `17 3 * * * cd /opt/besu-val3 && COPY_TO=user@offsite:/besu-chain ./snapshot-chain.sh /backup/chain` |
| Network files, `cluster.json`, tokens | operator | after every change, to the vault |

Prometheus alerts when a backup is too old or failed. Details and restore steps:
[`docs/disaster-recovery.md`](disaster-recovery.md).

### 4.14 Failover tests, then go live

Run the tests of section 6 one at a time, and check Grafana between them. Then point the
applications at `http://192.168.68.151:30000`.

## 5. What survives a failure

| Lost | Chain (4 validators, quorum 3) | Signing (MPC 2 of 3) | Application path | Effect |
|---|---|---|---|---|
| **.135** | ✅ val2–val4 | ✅ mpc2 + mpc3 via coord2 | ✅ VIPs move to .136: HAProxy → rpc2 + coord2, proxy2 starts | a few seconds of failed requests |
| **.136** | ✅ | ✅ | ✅ already on .135 | none (redundancy lost until it's back) |
| **.137** | ✅ | ✅ mpc1 + mpc3 | ✅ | none; the daily snapshot moves to another validator meanwhile |
| **.138** | ✅ | ✅ mpc1 + mpc2 | ✅ | none |
| **.139** | ✅ | ✅ | ✅ | no monitoring, no explorer |
| **two of .135–.138** | ❌ halts (2 of 4) | ❌ if both had MPC nodes | — | [`docs/disaster-recovery.md`](disaster-recovery.md) |
| .135 **and** .136 | ❌ halts (val3 + val4 = 2 of 4) | ❌ mpc2 + mpc3 alive, but no coordinator | ❌ | DR runbook |

Planned maintenance: never take two of .135–.138 down at once.

## 6. Failover tests (before going live, then twice a year)

| Test | Do | Expect |
|---|---|---|
| RPC | stop rpc1 | HAProxy uses rpc2 within ~6 s; transfers keep working |
| Coordinator | stop coord1 | signing via coord2 at once (warm pool); new accounts sign too |
| Proxy | stop proxy1 | VIP `.151` moves to .136, proxy2 starts, `/status/senders` answers on `.151` |
| HAProxy | `systemctl stop haproxy` on .135 | VIP `.150` moves to .136 |
| Host | power off .135 | both VIPs on .136; chain continues; a few seconds of errors |
| Validator | stop one validator | blocks continue; `BesuNodeDown` alert |
| MPC node | stop mpc2 | signing continues; `MpcNodeDown` alert |

After each test, start the component again and wait until Grafana shows everything up before the
next one.
