# monitoring: Prometheus + Grafana for besu-production and mpc-signer

The production counterpart of the Prometheus/Grafana bundled in `../besu-test-network`. It runs on
**one monitoring host** and scrapes, over the private network:

| What | Endpoint | Exposed by |
|---|---|---|
| Every Besu validator and RPC node | `http://<BIND_IP>:<METRICS_PORT>/metrics` (9545…) | `besu-production/node` |
| Every MPC coordinator | `http://<coordinator>:9100/metrics` (bearer token) | `mpc-signer` coordinator |
| MPC nodes | *not scraped*: each coordinator probes its nodes every 10 s and reports `mpc_node_up` | |
| Host CPU / memory / disk / network | `http://<host>:9101/metrics` | `node-exporter/` (one per host) |

Prometheus never needs to reach the MPC node hosts, and nothing here can sign or vote.

```
  monitoring host ─────────────── private network ──────────────────────────────
  ┌──────────────┐  9545  validators + RPC nodes (Besu metrics)
  │  Prometheus  │──9100──► MPC coordinator /metrics ──(probes /health)──► MPC node 0,1,2
  │  (localhost) │──9101──► node-exporter on every host
  └──────┬───────┘
         │ compose network
  ┌──────┴───────┐
  │   Grafana    │◄── browser (login required)   BIND_IP:3000
  └──────────────┘
```

Dashboards (folder **Production**):

| Dashboard | Shows |
|---|---|
| **Besu production (QBFT)** | chain height, seconds since last block, validators up vs expected, a table per node (up, height, peers, in sync, last block age, tx pool), block time, tx/s, gas, tx pool, peers, refused connections, JSON-RPC rate/latency, P2P traffic, CPU, JVM heap, GC |
| **MPC signer** | coordinator up, MPC nodes up vs threshold, keys, presignatures ready, signatures/s (hot/cold), signing latency p50/p95, failures and policy refusals, pool per hot key vs target, presign rate and duration |
| **Hosts** | CPU, memory, fullest disk, disk I/O, network per host |

Alerts (shown on the Prometheus *Alerts* page; to get notified, see [Operations](#operations)):

| Alert | Severity | Fires when |
|---|---|---|
| `BesuValidatorQuorumLost` | critical | fewer validators up than ceil(2n/3): the chain cannot make blocks |
| `BesuNoNewBlocks` | critical | the newest block is older than 3 × the block period + 5 s for 1 min. If it keeps firing after `BesuValidatorQuorumLost` has cleared, restart all validators together (see *Chain halted…* in `besu-production/README.md`) |
| `BesuNodeDown` | warning | a Besu node's metrics don't answer for 1 min |
| `BesuPeersMissing` | warning | a node has fewer peers than (nodes up − 1) for 5 min |
| `BesuNotInSync` | warning | a node is syncing or > 10 blocks behind for 5 min |
| `BesuTxPoolGrowing` | warning | > 1000 pending transactions on a node for 10 min |
| `BesuUnpermittedPeers` | info | a node refused a connection from a node not in `permissions_config.toml` |
| `BesuHeapHigh` | warning | Java heap > 90 % for 10 min |
| `MpcBelowThreshold` | critical | fewer MPC nodes reachable than the threshold: **no signatures possible** |
| `MpcCoordinatorDown` | critical | a coordinator's `/metrics` doesn't answer (or the token doesn't match) |
| `MpcNodeDown` | warning | an MPC node doesn't answer its coordinator for 1 min |
| `MpcPoolEmpty` | warning | no presignature ready for a hot key for 2 min (signing falls back to the slow path) |
| `MpcSignErrors` / `MpcPresignFailing` | warning | signing or presign sessions failing |
| `MpcPolicyRefusals` | warning | a transaction was refused by the policy (value, gas, chain id, destination) |
| `HostDown` / `HostDiskFull` / `HostMemoryHigh` | warning | node-exporter down; a disk > 80 %; memory > 90 % |

Dry run (4 validators + RPC node, 3 MPC nodes + coordinator, all targets up): one validator and
one MPC node stopped → `BesuNodeDown`, `MpcNodeDown`; a second of each → `BesuValidatorQuorumLost`,
`BesuNoNewBlocks`, `MpcBelowThreshold`; a value above the policy limit → `MpcPolicyRefusals`; a
nearly full test disk → `HostDiskFull`. The other rules were checked with `promtool` but not
triggered.

## Step by step

### 1. Expose the metrics

**Besu nodes:** nothing to do. Metrics are on `BIND_IP:METRICS_PORT` of every node, and the node
package adds `BIND_IP` to the host allowlist so Prometheus is accepted (an older node package
answers **403**: copy the current `docker-compose*.yml` and run `./start.sh`). Note each node's
`BIND_IP` and `METRICS_PORT` (9545, or 9545/9546/9547 when several nodes share a host).

**MPC coordinator(s):** set a token in the coordinator's `.env` and restart it:

```bash
openssl rand -hex 24          # use the output as the token
```

```bash
# mpc-signer/deploy/coordinator/.env
MPC_METRICS_TOKEN=<token>
```

```bash
docker compose up -d
```

**Every host (optional, for CPU/memory/disk):** copy `node-exporter/` to the host and run:

```bash
BIND_IP=<this host's private IP> docker compose up -d
```

It listens on `BIND_IP:9101` (9100 is the MPC coordinator's port).

### 2. Firewall

Allow the monitoring host to reach, and nothing else:

| To | Port |
|---|---|
| every Besu node | its `METRICS_PORT` (`besu-production/firewall-example.sh`, `PROMETHEUS=` + `METRICS_PORTS=`) |
| every MPC coordinator | 9100 (`mpc-signer/deploy/firewall-example.sh`, `PROMETHEUS=`) |
| every host with node-exporter | 9101 (both firewall scripts open it for the monitoring host) |

### 3. Install on the monitoring host

```bash
cp -r monitoring /opt/monitoring && cd /opt/monitoring
```

```bash
MPC_METRICS_TOKEN=<token> ./setup.sh
```

`setup.sh` creates `.env` with a random Grafana admin password (printed once) and
`secrets/mpc-metrics-token`. Then edit `.env`: `BIND_IP` = this host's private IP (Grafana is
published there).

### 4. List your targets

Edit the three files in `prometheus/targets/`. The examples match the network
`192.168.68.132` (val1, val2, rpc1), `.133` (val3), `.134` (val4):

| File | One entry per | Labels |
|---|---|---|
| `besu.yml` | Besu node: `"<BIND_IP>:<METRICS_PORT>"` | `node` = its `NODE_NAME`, `role` = `validator` or `rpc` |
| `mpc.yml` | coordinator: `"<host>:9100"` | `name` |
| `hosts.yml` | host with node-exporter: `"<host>:9101"` | `host` |

The `role` label matters: the quorum alert counts `role: validator`. Prometheus re-reads these files
by itself within a minute, so adding a node later needs no restart.

### 5. Start and check

```bash
docker compose up -d
```

Open `http://<BIND_IP>:3000`, log in with `admin` and the password from `setup.sh`. Then check
that every target is **up**: Grafana → *Explore*, query `up`, or on the monitoring host:

```bash
curl -s localhost:9090/api/v1/targets | grep -o '"health":"[a-z]*"' | sort | uniq -c
```

| Target down with | Cause |
|---|---|
| `403 Forbidden` (Besu) | old node package: Besu rejects the Host header. Update `docker-compose*.yml`, `./start.sh` |
| `401 Unauthorized` (coordinator) | `secrets/mpc-metrics-token` ≠ the coordinator's `MPC_METRICS_TOKEN` |
| `connection refused` / timeout | wrong IP/port in `targets/`, node down, or firewall |

## Operations

| Task | How |
|---|---|
| Add / remove a node | edit `prometheus/targets/*.yml` (picked up automatically) |
| Change alert rules or `prometheus.yml` | edit, then `curl -X POST http://127.0.0.1:9090/-/reload` |
| Look at Prometheus itself | it listens on `127.0.0.1:9090` only: `ssh -L 9090:127.0.0.1:9090 <monitoring host>` |
| Send alerts (mail, Slack, PagerDuty) | add an Alertmanager and uncomment `alerting:` in `prometheus.yml`, or use Grafana *Alerting → Contact points* |
| Change a dashboard | provisioned dashboards can't be saved from the UI: *Export → JSON*, replace the file in `grafana/dashboards/`, Grafana reloads it |
| Retention | `PROMETHEUS_RETENTION` in `.env` (default 30 days) |
| Rotate the metrics token | new `MPC_METRICS_TOKEN` on the coordinator(s), restart them, then `MPC_METRICS_TOKEN=<new> ./setup.sh` here (Prometheus re-reads the file) |
| Backups | nothing critical: dashboards and rules are files in this folder; metrics history is in the `prometheus-data` volume |

## Security

- Grafana requires a login: anonymous access and sign-up are off.
- Prometheus has no login: it is published on `127.0.0.1` only.
- The metrics contain no keys or secrets: counters, block numbers, peer counts and the addresses of
  the hot MPC keys. Still, keep port 9100/9545/9101 reachable only from the monitoring host and the
  clients that need them.
- `secrets/` and `.env` are git-ignored. Never commit them.
