# monitoring: Prometheus + Grafana for besu-production and mpc-signer

The production counterpart of the Prometheus/Grafana bundled in `../besu-test-network`. It runs on
**one monitoring host**, 192.168.68.139 in the production layout
([`../docs/production-layout.md`](../docs/production-layout.md)), next to chainlens, and scrapes,
over the private network:

| What | Endpoint | Exposed by |
|---|---|---|
| Every Besu validator and RPC node | `http://<BIND_IP>:<METRICS_PORT>/metrics` (9545…) | `besu-production/node` |
| Both MPC coordinators, on their own IPs | `http://<coordinator>:9100/metrics` (bearer token) | `mpc-signer` coordinator |
| The active proxy, through its floating IP | `http://192.168.68.151:30000/metrics` | `proxy` (per sender: in flight, nonce gaps, stalls, repairs) |
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
| **Besu production (QBFT)** | chain height, seconds since last block, validators up vs expected, a table per node (up, height, peers, in sync, last block age, tx pool), block time, tx/s, gas, tx pool, peers, refused connections, JSON-RPC rate/latency, P2P traffic, CPU, JVM heap, GC; **Proxy senders**: per sender mined OK / STALLED, in flight, nonce gap, repairs, fillers |
| **MPC signer** | coordinator up, MPC nodes up vs threshold, keys, presignatures ready, signatures/s (hot/cold), signing latency p50/p95, failures and policy refusals, pool per hot key vs target, presign rate and duration |
| **Hosts** | CPU, memory, fullest disk, disk I/O, network per host; **Backups**: age, size, result of every backup |
| **Sections** | ([`../docs/sections.md`](../docs/sections.md)) active sections, upfront accounts below the threshold, SENDER01; balances of every section's upfront / consumption / payment account (table and over time, with the threshold line); operations and ETH moved per section and kind (create account, +x, −x, NFT first sale / resale, top-up, sweep, pay back) |

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
| `MpcPoolEmpty` | warning | no presignature ready for a big (hot) key for 2 min (signing falls back to the slow path) |
| `MpcSmallPoolsEmpty` | warning | more than half of the small pools (accounts from `/createaccount`) empty for 15 min: presigning can't keep up |
| `MpcSignErrors` / `MpcPresignFailing` | warning | signing or presign sessions failing |
| `MpcPolicyRefusals` | warning | a transaction was refused by the policy (value, gas, chain id, destination) |
| `ProxySenderStalled` | critical | a sender's transactions are ready in the RPC node's pool but blocks keep coming without them: the validators don't have them. Restart **one** validator; check `tx-pool-max-future-by-sender=2000` on the validators |
| `ProxyNonceGap` | warning | a missing nonce has blocked a sender for > 2 min (the proxy normally repairs it after 30 s / 10 blocks) |
| `ProxyNonceRepaired` | info | the proxy repaired a gap (lost transactions or filler transactions): see its log |
| `ProxySenderCheckFailing` / `ProxyDown` | warning / critical | the proxy can't read Besu for its check / doesn't answer |
| `SectionUpfrontLow` | warning | an enabled section's upfront account below `upfront_low_balance_eth` for 2 min: top it up (chainlens → Sections) |
| `SectionUpfrontEmpty` | critical | an enabled section's upfront account is empty: its `/createaccount` (with an amount) and `/transfer -x` are refused |
| `Sender01Low` | warning | SENDER01 below `sender01_low_balance_eth` for 5 min (it funds every top-up): pay money back from payment accounts |
| `SectionMetricsFailing` | warning | the proxy can't read the section balances for 10 min |
| `HostDown` / `HostDiskFull` / `HostMemoryHigh` | warning | node-exporter down; a disk > 80 %; memory > 90 % |
| `HostClockNotSynced` | warning | a host's clock not synchronized by chrony, or more than 100 ms off, for 10 min (QBFT rejects blocks with bad timestamps) |
| `BackupFailed` | warning | the last run of a backup script failed |
| `ChainSnapshotTooOld` / `ChainSnapshotMissing` | warning | no chain snapshot in 2 days / never |
| `MpcShareBackupTooOld` / `MpcShareBackupMissing` | warning | an MPC node's share backup older than 2 hours / fewer than 3 nodes backed up |
| `ValidatorKeyBackupMissing` | warning | a validator key never backed up |

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

It listens on `BIND_IP:9101` (9100 is the MPC coordinator's port). It also publishes the results of
the backup scripts on that host (`snapshot-chain.sh`, `backup-key.sh`, the MPC `backup.sh`): they
write small `*.prom` files to `/var/lib/node_exporter/textfile` (change with `TEXTFILE_DIR` here
and `BACKUP_METRICS_DIR` for the scripts), shown in the **Backups** table and alerted on in
`rules/backups.yml`. Run node-exporter on every host that runs a backup.

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

With the Ansible deployment this is automatic: it generates them from the IP plan into
`prometheus/targets.generated/` and sets `PROMETHEUS_TARGETS_DIR` in `.env` (`check-targets.sh`
reads the same setting). By hand: edit the four files in `prometheus/targets/`. They are filled in
for the production layout:
val1 + rpc1 on .135, val2 + rpc2 on .136, val3 on .137, val4 on .138 (validators on metrics port
9545, RPC nodes on 9546), coord1/coord2 on .135/.136, the proxy on its floating IP `.151`, and
node-exporter on all five hosts:

| File | One entry per | Labels |
|---|---|---|
| `besu.yml` | Besu node: `"<BIND_IP>:<METRICS_PORT>"` | `node` = its `NODE_NAME`, `role` = `validator` or `rpc` |
| `mpc.yml` | coordinator: `"<host>:9100"` | `name` |
| `proxy.yml` | the proxy's **floating IP**: `"192.168.68.151:30000"` (the standby proxy is stopped, so its host would always show down) | `name` |
| `hosts.yml` | host with node-exporter: `"<host>:9101"` | `host` |

The `role` label matters: the quorum alert counts `role: validator`. Prometheus re-reads these files
by itself within a minute, so adding a node later needs no restart.

### 5. Start and check

```bash
docker compose up -d
```

Open `http://<BIND_IP>:3000`, log in with `admin` and the password from `setup.sh`.

### 6. Test the metrics endpoints

**All at once** (on the monitoring host, so the network path is the same as Prometheus'):

```bash
./check-targets.sh
```

It reads `prometheus/targets/*.yml`, calls every `/metrics` (with the token for coordinators) and
prints one line per target. It exits with 1 if any target fails:

```
Besu nodes (targets/besu.yml)
  OK   besu   val1           192.168.68.135:9545
  FAIL besu   rpc1           192.168.68.135:9546  -> 403: Besu refuses the Host header: old node package, ...
MPC coordinators (targets/mpc.yml)
  FAIL mpc    coord2         192.168.68.136:9100  -> 404: old coordinator image without /metrics: ...
Proxy (targets/proxy.yml)
  OK   proxy  proxy          192.168.68.151:30000
Hosts / node-exporter (targets/hosts.yml)
  OK   host   host-135       192.168.68.135:9101
Prometheus scrape status:
      7 "health":"up"
      2 "health":"down"
```

**One endpoint by hand** (prints the HTTP status; `200` = OK):

```bash
# Besu node: <BIND_IP>:<METRICS_PORT> from that node's .env
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.68.135:9545/metrics
```

```bash
# MPC coordinator: needs the metrics token
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat secrets/mpc-metrics-token)" http://<coordinator IP>:9100/metrics
```

```bash
# node-exporter on a host
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.68.136:9101/metrics
```

**Look at a few values** (useful to see that the numbers are real):

```bash
# Besu: height, peers, in sync
curl -s http://192.168.68.135:9545/metrics | grep -E '^(ethereum_blockchain_height|ethereum_peer_count|besu_synchronizer_in_sync) '
```

```bash
# MPC: nodes up, keys, pool, signatures
curl -s -H "Authorization: Bearer $(cat secrets/mpc-metrics-token)" http://<coordinator IP>:9100/metrics | grep -E '^mpc_(node_up|keys|pool_ready|signs_total)'
```

**What Prometheus sees** (the same data Grafana uses):

```bash
curl -s localhost:9090/api/v1/targets | grep -o '"health":"[a-z]*"' | sort | uniq -c
```

```bash
# the error of every target that is down, e.g.
# "scrapeUrl":"http://192.168.68.136:9101/metrics","lastError":"Get "...": connect: connection refused"
curl -s localhost:9090/api/v1/targets | grep -oE '"scrapeUrl":"[^"]*","globalUrl":"[^"]*","lastError":"([^"\\]|\\.)+"' | sed -E 's/"globalUrl":"[^"]*",//; s/\\"/"/g'
```

| Status | Meaning | Fix |
|---|---|---|
| `200` | OK | |
| `403` (Besu) | old node package: Besu rejects the Host header | copy the new `docker-compose*.yml` to the node, `./start.sh` |
| `401` (coordinator) | `secrets/mpc-metrics-token` ≠ the coordinator's `MPC_METRICS_TOKEN` | same value on both sides, restart the coordinator |
| `404` (coordinator) | coordinator image older than `/metrics` | build and deploy the new `mpc-signer` image, set `MPC_IMAGE` |
| `000` | no answer | wrong IP/port in `targets/`, service down, or firewall blocks the monitoring host |

## Operations

| Task | How |
|---|---|
| Add / remove a node | edit `prometheus/targets/*.yml` (picked up automatically) |
| Change alert rules or `prometheus.yml` | edit, then `curl -X POST http://127.0.0.1:9090/-/reload` |
| Look at Prometheus itself | it listens on `127.0.0.1:9090` only: `ssh -L 9090:127.0.0.1:9090 <monitoring host>` |
| Send alerts (mail, Slack, PagerDuty) | add an Alertmanager and uncomment `alerting:` in `prometheus.yml`, or use Grafana *Alerting → Contact points* |
| Change a dashboard | provisioned dashboards can't be saved from the UI: *Export → JSON*, replace the file in `grafana/dashboards/`, Grafana reloads it |
| Retention | `PROMETHEUS_RETENTION` in `.env` (default 30 days; Ansible: `prometheus_retention`, 400d) and the disk cap `PROMETHEUS_RETENTION_SIZE` (Ansible: `prometheus_retention_size`, 20GB) |
| Rotate the metrics token | new `MPC_METRICS_TOKEN` on the coordinator(s), restart them, then `MPC_METRICS_TOKEN=<new> ./setup.sh` here (Prometheus re-reads the file) |
| Backups | nothing critical: dashboards and rules are files in this folder; metrics history is in the `prometheus-data` volume |

## Security

- Grafana requires a login: anonymous access and sign-up are off.
- Prometheus has no login: it is published on `127.0.0.1` only.
- The metrics contain no keys or secrets: counters, block numbers, peer counts and the addresses of
  the hot MPC keys. Still, keep port 9100/9545/9101 reachable only from the monitoring host and the
  clients that need them.
- `secrets/` and `.env` are git-ignored. Never commit them.
