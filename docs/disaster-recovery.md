# Disaster recovery runbook

What to back up, how to know the backups work, and the exact steps to recover from each kind of
loss. It covers `besu-production/`, `mpc-signer/deploy/`, `proxy/`, `chainlens/` and `monitoring/`.

Keep a **printed or offline copy** of this page and of the contact list: during a disaster the
repository, the wiki or the network may be unavailable.

## 1. Roles and contacts

Fill in before going live.

| Role | Responsible for | Name / phone |
|---|---|---|
| Incident lead | decides, coordinates, communicates | |
| Besu operator | network files, validator votes | |
| Validator host teams | their host, their validator key | |
| MPC node team 0 / 1 / 2 | their node, its backup, its passphrase (separately) | |
| Application team | proxy, coordinator, chainlens | |

**Rule:** no single person ever holds two MPC shares, or one share and its passphrase.

## 2. What must survive, and where it is

| Item | Loss without a backup | Backup | Where it's kept |
|---|---|---|---|
| **MPC key shares** (3 nodes) | 1 node: no redundancy left. **2 nodes: all MPC accounts' funds lost forever.** | `mpc-signer/deploy/node/backup.sh`, **hourly**, per node | that node team's storage + off-site; **passphrase stored separately** |
| **Validator keys** (4) | 1: replace by vote. **2 of 4 at once: the chain stops for good** (no quorum to vote replacements) | `besu-production/node/backup-key.sh`, **once**, then encrypt | each team's vault + off-site |
| **RPC node keys** | new key needs new network files on every node | `backup-key.sh` (recorded as `node-key`) | operator vault |
| **Network files** (`genesis.json`, `static-nodes.json`, `permissions_config.toml`, `SHA256SUMS`) | `genesis.json` can't be regenerated identically | copy of `network/`, after each change | operator vault + off-site |
| **Chain data** | all nodes lost = every balance and NFT lost | `besu-production/node/snapshot-chain.sh`, **daily** | off-site (`COPY_TO`) |
| **Settings and secrets** (`.env` of each host, `cluster.json`, proxy `.env`) | services can't be rebuilt identically; a lost MPC passphrase = a lost share | copy after each change | each team's vault |
| Proxy, chainlens, Redis | nothing to lose: redeploy from git (Redis is only a cache, NFT metadata is on chain) | — | — |
| Monitoring | history only (config is in git) | — | — |

**Off-site** means a different building or cloud account, and at least one copy **offline or
write-once** (ransomware encrypts every backup it can reach).

## 3. Backup schedule

| What | Command (from that host's directory) | When (cron example) |
|---|---|---|
| Chain snapshot | `./snapshot-chain.sh /backup/chain` with `COPY_TO=user@offsite:/besu-chain` | daily: `17 3 * * * cd /opt/besu-val3 && COPY_TO=… ./snapshot-chain.sh /backup/chain` |
| MPC shares | `./backup.sh /secure/backup` (on each MPC node) | hourly: `0 * * * * /opt/mpc-node/backup.sh /secure/backup` |
| Validator / node keys | `./backup-key.sh /secure/dir`, then `gpg --symmetric` and delete the plain copy | once per key |
| Network files | `cp -r network /secure/network-$(date +%F)` (operator) | after every change |

**Which node takes the chain snapshot:** it is **stopped** for a few minutes while its data is
archived. Use a node your applications don't depend on: a second RPC node, `rpc-explorer`, or a
validator (the chain continues with the other three). **Never** the only RPC node of the proxy and
coordinator. The script refuses to stop a node that doesn't see all its peers (another node is
already down), so a snapshot can't halt the chain.

The snapshot contains **no keys** and can be restored onto any node of the same chain.

### Is it working? (monitoring)

Each backup script records its result. With node-exporter on the host (with its textfile
directory, the default in `monitoring/node-exporter`), the **Hosts** dashboard shows a **Backups**
table, and Prometheus alerts:

| Alert | When |
|---|---|
| `BackupFailed` | the last run of a backup failed |
| `ChainSnapshotTooOld` / `ChainSnapshotMissing` | no chain snapshot in 2 days / ever |
| `MpcShareBackupTooOld` / `MpcShareBackupMissing` | an MPC node not backed up in 2 hours / fewer than 3 nodes ever backed up |
| `ValidatorKeyBackupMissing` | a validator key has never been backed up |

## 4. Recovery objectives

| Event | Data loss (RPO) | Time to recover (RTO, rough) |
|---|---|---|
| Any single node or host, other nodes alive | none (they re-sync from peers) | 30 min – a few hours, mainly hardware |
| One MPC node | none (other 2 hold every share) | ~1 h |
| Whole site | chain: since the last **off-site snapshot** (up to 1 day); MPC: since the last backup | a day or more |

## 5. First response (any incident)

1. **Look before acting.** Grafana: the Alerts row on any dashboard; Besu: validators up, seconds
   since last block; MPC: nodes up vs threshold; Hosts: which hosts are down.
2. On the monitoring host: `./check-targets.sh` lists every node that doesn't answer.
3. **Classify** with the table below, name an incident lead, **freeze** other changes.
4. Silence follow-on alerts (if Alertmanager is used) so the real signal isn't buried.
5. Never run `reset-chain.sh`, `docker volume rm` or `docker compose down -v` on a node until you are
   sure its data isn't needed. Copy first if in doubt.

| What you see | Go to |
|---|---|
| one validator down, blocks continue | [6.1](#61-one-validator-host-lost) |
| **blocks stopped**, 2 validators down (e.g. host .132) | [6.2](#62-the-host-with-two-validators-lost-eg-192168681320) |
| blocks continue, apps can't reach Besu | [6.3](#63-an-rpc-node-lost) |
| `MpcNodeDown`, signing still works | [6.4](#64-one-mpc-node-lost) |
| `MpcBelowThreshold`, **no signatures** | [6.5](#65-two-mpc-nodes-lost) |
| coordinator / proxy / chainlens down | [6.6](#66-coordinator-proxy-chainlens-or-monitoring-host-lost) |
| everything down | [6.7](#67-whole-site-lost) |
| suspected intrusion / ransomware | [6.8](#68-intrusion-or-ransomware) |

## 6. Procedures

All Besu commands run in the node's directory (e.g. `/opt/besu-val3`), which holds the
`besu-production/node` files, its `.env` and `network/`.

### 6.1 One validator host lost

The chain continues with 3 of 4 validators. Don't take another validator down until this one is
back.

1. Prepare a host with the **same IP** (the enode in the network files contains it), Docker and
   Compose, firewall rules (`firewall-example.sh`).
2. Copy the node package, its `.env` (from the vault: same `NODE_NAME`, ports, `BESU_ROLE`) and the
   4 network files into `network/`.
3. Restore its key (decrypt the backup first) and start:
   ```bash
   ./restore-key.sh /secure/validator3.key        # prints the enode; must say "OK: … in static-nodes.json"
   ./start.sh                                     # syncs from the other nodes
   ```
4. Check: `RPC=http://127.0.0.1:<RPC_PORT> ./qbft.sh health` → block number rising, peers = nodes − 1.

**Key lost (no backup):** run `./init.sh` (new key), then on the operator side
`operator/add-node.sh network/ <new node>.json`, distribute the network files to every node,
restart them one at a time, and vote: `qbft.sh propose 0x<new address> true` on more than half of
the validators, then `qbft.sh propose 0x<old address> false`. See `besu-production/README.md`.

**New IP (same key):** in `network/static-nodes.json` and `network/permissions_config.toml`, replace
the old `@<ip>:<port>` of that enode with the new one, regenerate the checksums
(`sha256sum genesis.json static-nodes.json permissions_config.toml > SHA256SUMS`), copy the 4 files
to **every** node and restart them one at a time. Never change `genesis.json`.

### 6.2 The host with two validators lost (e.g. 192.168.68.132)

**Blocks stop** (2 of 4 validators), and on .132 also rpc1, the coordinator and the proxy. Priority:
get **both validators** back, everything else depends on blocks.

1. Replacement host with the **same IP** (or follow "New IP" in 6.1 for each node).
2. Restore **val1 and val2** as in 6.1 steps 2–3 (`restore-key.sh` + `start.sh` in each directory;
   `COMPOSE_FILE=docker-compose.host.yml` in their `.env`).
3. When both have peers: blocks resume. **If no new block within about a minute**, the validators'
   QBFT rounds have drifted apart during the outage: restart **all four validators at the same
   time** (`docker compose restart` in each directory). Nothing is lost; in tests blocks resumed
   within ~25 s.
4. Restore rpc1 (6.3), then the coordinator and proxy (6.6).

**If the keys of val1 and val2 are both lost:** the chain can't continue (no quorum, so no vote to
replace them). Recovery means a **new chain**: new genesis with the balances re-created, which is a
business decision, not a runbook step. This is why validator key backups are mandatory.

### 6.3 An RPC node lost

Blocks continue; applications using that node fail.

1. Quick fix: point the proxy (`BESU_IP`), the coordinator (`MPC_BESU_RPC`) and chainlens
   (`BESU_RPC`) at another RPC node if you have one.
2. Rebuild as 6.1 (same IP, `restore-key.sh` with its backed-up node key, `start.sh`). For a large
   chain, restore the latest snapshot first to skip the full sync:
   `./restore-key.sh …` → `./restore-chain.sh /backup/chain/besu-chain-…tgz` (starts the node).

### 6.4 One MPC node lost

Signing continues with the other two (slower until the presignature pool refills); `/createaccount`
fails until all three are up. **Fix it today**: there is no redundancy left.

1. New host. Same `.env` as before (`MPC_NODE_ID`, **same** `MPC_NODE_PASSPHRASE`, tokens) and the
   same `cluster.json`.
2. Restore and start:
   ```bash
   cd /opt/mpc-node
   docker compose down
   ./restore.sh /secure/backup/mpc-node1-<time>.tgz
   docker compose up -d
   ```
3. If the node's **IP changed**: update its `url` in `cluster.json`, compare `sha256sum cluster.json`
   with all teams, copy it to every node and coordinator, restart them one by one.
4. On the coordinator: `POST /admin/pool/clear` (admin token), then check the MPC dashboard: nodes
   up = 3.
5. Accounts created **after** that backup: their share on this node is missing (the other two still
   have it, so they can sign). Take a fresh backup on all nodes now, and plan to move those accounts'
   funds to new keys if you want full redundancy back for them.

**No backup or no passphrase for that node:** signing still works with 2 of 3, but redundancy is
gone for good (the library can't re-share keys). Build a new cluster and move all funds:
`mpc-signer/docs/production.md`, step 14.

### 6.5 Two MPC nodes lost

**No signatures possible.** Restore both nodes from their teams' backups (6.4, each team for its own
node). As soon as **two** nodes are up, signing works again.

- If one of the two can't be restored: with the remaining two, **immediately move all funds** to a
  new cluster (production.md step 14). You are one failure away from losing them.
- If neither can be restored: the funds on MPC accounts are lost. This is why each node is backed up
  hourly, by its own team, off-site.

### 6.6 Coordinator, proxy, chainlens or monitoring host lost

All four are stateless: redeploy from git plus the saved `.env` / `cluster.json`.

| Component | Rebuild | Check |
|---|---|---|
| MPC coordinator | `mpc-signer/deploy/coordinator`: `.env`, `cluster.json`, `docker compose up -d` | log `keys loaded from nodes`; MPC dashboard |
| Proxy | `proxy/`: `.env`, `docker compose up -d --build` (Redis optional, starts empty) | `GET /status/senders`: no gap, no stall; a test transfer |
| Chainlens | `chainlens/`: `.env`, `docker compose up -d --build` | re-indexes from block 0 by itself |
| Monitoring | `monitoring/`: `setup.sh` with the metrics token, targets, `docker compose up -d` | `./check-targets.sh`; history before the loss is gone |

### 6.7 Whole site lost

Everything down. Work in this order; each step needs the previous one.

1. **Hosts and network:** replacement hosts with the **same IPs** (otherwise follow "New IP" in 6.1
   for each node), the private network, firewalls, Docker.
2. **Besu, all nodes**, in each node directory (package + `.env` + the 4 network files from the
   operator vault):
   ```bash
   ./restore-key.sh /secure/<node>.key                          # every node, validators first
   ./restore-chain.sh --yes /backup/chain/besu-chain-…tgz       # same latest snapshot on every node; starts it
   ```
   Restoring the snapshot on every node avoids each node syncing from block 0. (Alternatively
   restore it on one node only and let the others sync from it.)
3. **Check blocks:** `qbft.sh health` on a validator → height above the snapshot block and rising.
   No new block within a minute → restart all validators together (see 6.2 step 3).
4. **MPC nodes:** each team restores its node (6.4 steps 1–2). Then the coordinator(s) (6.6).
5. **Proxy, chainlens, monitoring** (6.6).
6. **Reconcile:** the chain is back at the snapshot's block. Everything after it is **gone**:
   transfers, NFT mints and sales, account fundings. Compare with your business records and redo
   what must be redone. The proxy takes its nonces from the chain by itself. MPC accounts created
   after the snapshot still have their keys (if the MPC backups are newer), but their on-chain
   funding is gone.

### 6.8 Intrusion or ransomware

1. **Isolate** the affected hosts from the network; don't wipe them yet (evidence).
2. Rebuild affected hosts **from clean images**, never from the compromised system.
3. Restore from **offline / off-site** copies taken **before** the intrusion (6.1–6.7).
4. **Rotate every secret** the attacker could have read: `MPC_NODE_TOKEN`, `MPC_ADMIN_TOKEN`,
   `MPC_METRICS_TOKEN`, Grafana password, SSH keys, cloud credentials.
5. **MPC:** if an attacker may have obtained one node's share **and** its passphrase, the funds are
   still safe (two shares are needed), but move them to a new cluster (production.md step 14) to
   restore the margin. If two nodes may be compromised, move the funds **immediately**.
6. Validator key stolen: vote that validator out and a new one in (6.1 "Key lost").

## 7. After any recovery: checklist

- [ ] Grafana: no firing alerts; validators up = 4, nodes up as expected, blocks every period
- [ ] every Besu node has peers = nodes − 1 (Nodes table)
- [ ] MPC: 3 nodes up, pool refilling, a test signature (`eth_signTransaction` on the coordinator)
- [ ] proxy: `GET /status/senders` with no gap or stall; one test transfer mined
- [ ] chainlens shows the latest blocks
- [ ] **take fresh backups now**: a chain snapshot, an MPC backup on every node, keys of any new node
- [ ] write down what happened, how long each step took, and what to improve in this runbook

## 8. Drills

A backup that has never been restored isn't proven. Every **quarter**, on a **test host** that is
**not** connected to the production network:

| Drill | How | Pass |
|---|---|---|
| Chain snapshot | copy the node package and `network/` to the test host, `./init.sh`, `./restore-chain.sh --yes <latest snapshot>` | the node starts and `eth_blockNumber` returns the snapshot's block (it has no peers; that's expected) |
| MPC share backup | each team: on its own test host, `restore.sh` the latest archive into a fresh node directory with the same `.env`, start it **without** network access to the cluster | its log shows `node loaded` with `keys=` the expected number of accounts and `has_aux=true` |
| Validator key | decrypt the backup, `./restore-key.sh` into a scratch directory with that node's `.env` and network files | prints `OK: this enode is in network/static-nodes.json` |
| Contacts | call every number in section 1 | everyone reachable |

Record the date and the result of each drill.
