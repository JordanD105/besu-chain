# Alert runbook

> **What:** the solution for every alert, step by step: confirm, fix (with commands), check that it
> cleared. One section per alert, named after it.
>
> **For:** operators on duty.
>
> **Related:** [alerts](alerts.md) (when each alert fires) · [Grafana dashboards](dashboards.md) ·
> [troubleshooting](troubleshooting.md) · [disaster recovery](disaster-recovery.md)

**Contents**

- [Before you start](#before-you-start)
- [Besu](#besu): [BesuValidatorQuorumLost](#besuvalidatorquorumlost) · [BesuNoNewBlocks](#besunonewblocks) · [BesuNodeDown](#besunodedown) · [BesuNodeStalled](#besunodestalled) · [BesuNotInSync](#besunotinsync) · [BesuPeersMissing](#besupeersmissing) · [BesuPeersLow](#besupeerslow) · [BesuTxPoolGrowing](#besutxpoolgrowing) · [BesuHeapHigh](#besuheaphigh) · [BesuUnpermittedPeers](#besuunpermittedpeers)
- [MPC signer](#mpc-signer): [MpcBelowThreshold](#mpcbelowthreshold) · [MpcCoordinatorDown](#mpccoordinatordown) · [MpcNodeDown](#mpcnodedown) · [MpcPoolEmpty](#mpcpoolempty) · [MpcSmallPoolsEmpty](#mpcsmallpoolsempty) · [MpcPresignFailing](#mpcpresignfailing) · [MpcSignErrors](#mpcsignerrors) · [MpcPolicyRefusals](#mpcpolicyrefusals)
- [Proxy and Redis](#proxy-and-redis): [ProxyDown](#proxydown) · [ProxySenderStalled](#proxysenderstalled) · [ProxyNonceGap](#proxynoncegap) · [ProxyNonceRepaired](#proxynoncerepaired) · [ProxySenderCheckFailing](#proxysendercheckfailing) · [ProxyHttpErrors](#proxyhttperrors) · [ProxySlow](#proxyslow) · [ProxyEventLoopBlocked](#proxyeventloopblocked) · [ProxyRedisDisconnected](#proxyredisdisconnected) · [RedisDown](#redisdown) · [RedisMemoryHigh](#redismemoryhigh)
- [Sections](#sections): [SectionUpfrontEmpty](#sectionupfrontempty) · [SectionUpfrontLow](#sectionupfrontlow) · [Sender01Low](#sender01low) · [SectionMetricsFailing](#sectionmetricsfailing)
- [Hosts](#hosts): [HostDown](#hostdown) · [HostMemoryHigh](#hostmemoryhigh) · [HostDiskFull](#hostdiskfull) · [HostClockNotSynced](#hostclocknotsynced)
- [Backups](#backups): [BackupFailed](#backupfailed) · [ChainSnapshotTooOld](#chainsnapshottooold) · [ChainSnapshotMissing](#chainsnapshotmissing) · [MpcShareBackupTooOld](#mpcsharebackuptooold) · [MpcShareBackupMissing](#mpcsharebackupmissing) · [ValidatorKeyBackupMissing](#validatorkeybackupmissing)

---

## Before you start

1. **Look at all firing alerts together** (Grafana, top of any dashboard). One cause often raises
   several alerts: fix the **cause** first. A `HostDown` usually explains every other alert of the
   same host ([reading an incident](alerts.md#reading-an-incident)).
2. **Critical first**, then warnings, then info.
3. **Note the time.** Grafana shows your local time; logs on the hosts may be UTC.

Names used below (production defaults):

| Thing | Name / place |
|---|---|
| Besu node `<node>` (val1–val4, rpc1, rpc2) | directory `/opt/besu-<node>`, container `besu-<node>-besu-1` |
| Hosts | h135 val1, rpc1, coord1, mpc1, proxy · h136 val2, rpc2, coord2, proxy (standby) · h137 val3, mpc2 · h138 val4, mpc3 · h139 monitoring, chainlens, Remix, docs |
| Coordinator | `/opt/mpc-coordinator`, container `mpc-coordinator-mpc-coordinator-1`, port 9100 |
| MPC node | `/opt/besu-chain/mpc-signer/deploy/node` (`mpc_node_dir`), container `node-mpc-node-1`, port 7000 |
| Proxy, Redis | `/opt/besu-chain/proxy`, containers `proxy-proxy-1`, `proxy-redis-1`; runs on the host holding VIP `.151` |
| Monitoring | `/opt/monitoring` on h139 (Prometheus on `127.0.0.1:9090` there) |
| Ansible | run from `ansible/` on the operator |

Useful everywhere:

```bash
docker ps -a --format '{{.Names}} {{.Status}}'
```

```bash
docker logs --since 30m <container> 2>&1 | grep -iE "error|fail|exception|warn" | tail -50
```

---

## Besu

### BesuValidatorQuorumLost

**Critical.** Fewer validators online than QBFT needs (3 of 4): no blocks.

1. **Confirm:** Besu production → *Validators up*; the Nodes table shows which are DOWN.
2. **Fix:** bring validators back, one at a time, on their hosts:
   ```bash
   docker start besu-<node>-besu-1
   ```
   If the host is down, see [HostDown](#hostdown). If the container exits again, read its log
   (disk full, a corrupt database: [disaster recovery](disaster-recovery.md)).
3. **Check:** *Validators up* ≥ 3 and *Seconds since last block* back under 1 s. If blocks don't
   resume within a minute of quorum being back, see [BesuNoNewBlocks](#besunonewblocks).

### BesuNoNewBlocks

**Critical.** No block for 3 × the block period + 5 s.

1. **Confirm:** *Seconds since last block* climbing; is `BesuValidatorQuorumLost` also firing?
2. **Fix:**
   - Quorum lost: fix that first ([BesuValidatorQuorumLost](#besuvalidatorquorumlost)).
   - Quorum is back but still no blocks (validators out of round): restart **all validators
     together**, on each of h135–h138 at the same time:
     ```bash
     docker restart besu-val<N>-besu-1
     ```
     Details: *Chain halted* in [Besu manual setup](../deployment/besu-manual.md).
   - Check the clocks too ([HostClockNotSynced](#hostclocknotsynced)).
3. **Check:** blocks every second again; then RPC nodes catch up by themselves.

### BesuNodeDown

**Warning.** A Besu node's metrics don't answer for 1 minute.

1. **Confirm:** the alert names the node. Is the host up (`HostDown`)?
2. **Fix** on its host:
   ```bash
   docker ps -a --filter name=besu-<node>
   ```
   ```bash
   docker logs --tail 100 besu-<node>-besu-1
   ```
   Restarting? Look at the log: disk full ([HostDiskFull](#hostdiskfull)), out of memory
   ([HostMemoryHigh](#hostmemoryhigh)), database error ([disaster recovery](disaster-recovery.md)).
   Stopped:
   ```bash
   docker start besu-<node>-besu-1
   ```
   To redeploy it with Ansible: `ansible-playbook 05-besu.yml --limit <host>`.
3. **Check:** UP in the Nodes table, then IN SYNC within a minute or two.

### BesuNodeStalled

**Warning.** The node's newest block is over 60 s old while the chain is current: it stopped
importing, even if it still says "in sync".

1. **Confirm:** Nodes table: Sync **STALLED**, Last block age climbing, Behind growing. Check its
   Peers (often low).
2. **Fix:**
   - **RPC node (rpc1, rpc2):** it is already out of the RPC VIP; `besu-rpc-health` restarts it after
     5 minutes. To do it now, on its host:
     ```bash
     docker restart besu-<node>-besu-1
     ```
   - **Validator:** restart it the same way (the others keep making blocks).
   - Then find why: peers dropped (network, firewall reload), memory pressure on the host:
     ```bash
     docker logs --since 1h besu-<node>-besu-1 2>&1 | grep -viE "Imported|pending blocks" | tail -50
     ```
3. **Check:** IN SYNC, Behind back to ~0. On h135 / h136: `curl -s http://127.0.0.1:8410/` shows
   the RPC node healthy.

### BesuNotInSync

**Warning.** The node says it is syncing, or is more than 10 blocks behind the best block it knows,
for 5 minutes.

1. **Confirm:** Nodes table (SYNCING / BEHIND), *Blocks behind* chart. Right after a restart this is
   normal for a few minutes.
2. **Fix:** if it doesn't come down: check its peers ([BesuPeersLow](#besupeerslow)) and log; if the
   height doesn't move at all, treat it as [BesuNodeStalled](#besunodestalled).
3. **Check:** Blocks behind 0, Sync IN SYNC.

### BesuPeersMissing

**Warning.** A node has fewer peers than (nodes up − 1) for 5 minutes.

1. **Confirm:** *Peers* chart: which node, since when.
2. **Fix:** from that node's host, test the other nodes' P2P ports (30303 validators, 30304 RPC
   nodes):
   ```bash
   nc -zv 192.168.68.137 30303
   ```
   Refused or timing out: the firewall (rerun `01-hosts.yml`), or the other node is down. A node
   that was recreated with a new key or address must be in `static-nodes.json` and
   `permissions_config.toml` of every node ([Besu manual setup](../deployment/besu-manual.md)).
3. **Check:** 5 peers on every node.

### BesuPeersLow

**Warning.** A node has fewer than 2 peers for 2 minutes: it is one connection away from isolation
and can stall.

1. **Confirm and fix** as [BesuPeersMissing](#besupeersmissing). If the peers don't come back,
   restart the node (it reconnects to its static peers):
   ```bash
   docker restart besu-<node>-besu-1
   ```
2. **Check:** Peers ≥ 2 (normally 5); watch for [BesuNodeStalled](#besunodestalled).

### BesuTxPoolGrowing

**Warning.** More than 1,000 pending transactions on a node for 10 minutes.

1. **Confirm:** *Transaction pool* chart; Proxy & Redis → *Senders needing attention* (STALLED, NONCE GAP).
2. **Fix:**
   - A sender STALLED: [ProxySenderStalled](#proxysenderstalled).
   - A nonce gap: [ProxyNonceGap](#proxynoncegap).
   - Real load above capacity: blocks are full (*Gas used per block* near the limit): slow the
     clients down; the pool drains by itself.
3. **Check:** the pool shrinks back to ~0.

### BesuHeapHigh

**Warning.** Java heap above 90 % of its maximum for 10 minutes.

1. **Confirm:** *JVM heap used* close to the green max line; *GC time* rising.
2. **Fix:** short term, restart the node (`docker restart besu-<node>-besu-1`). If it comes back:
   raise `besu_java_opts` (e.g. `-Xmx6g`) in `settings.yml`, only if the host has the memory, then
   `ansible-playbook 05-besu.yml`.
3. **Check:** a sawtooth well below the maximum.

### BesuUnpermittedPeers

**Info.** A node refused a connection from a node not in `permissions_config.toml`.

1. **Confirm** who it was:
   ```bash
   docker logs --since 1h besu-<node>-besu-1 2>&1 | grep -i "not permitted\|unpermitted" | tail
   ```
2. **Fix:** an unknown machine: block it at the firewall and investigate. One of your nodes with a
   new key or address: add it to `permissions_config.toml` and `static-nodes.json` on every node
   ([Besu manual setup](../deployment/besu-manual.md)).

---

## MPC signer

### MpcBelowThreshold

**Critical.** Fewer MPC nodes reachable than the threshold (2 of 3): **no signatures**.

1. **Confirm:** MPC signer → *MPC nodes up*, the *MPC nodes* table (which nodes, from which
   coordinator).
2. **Fix:** bring MPC nodes back. Each node belongs to its team; on its host:
   ```bash
   cd /opt/besu-chain/mpc-signer/deploy/node && docker compose up -d
   ```
   ```bash
   docker logs --tail 50 node-mpc-node-1
   ```
   A node that can't unseal its share needs its `MPC_NODE_PASSPHRASE` (the team's copy). Lost
   shares: [MPC signer in production](../deployment/mpc-signer-production.md) (restore).
3. **Check:** *MPC nodes up* ≥ 2, signatures flow again.

### MpcCoordinatorDown

**Critical.** A coordinator's `/metrics` doesn't answer (or the metrics token doesn't match).
The other coordinator keeps signing through the VIP.

1. **Confirm:** is it down, or only the metrics token?
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://192.168.68.135:9100/health
   ```
   200 = up: the token in `/opt/monitoring/secrets/mpc-metrics-token` doesn't match the
   coordinator's `MPC_METRICS_TOKEN` (rerun `09-monitoring.yml`).
2. **Fix** (down), on its host:
   ```bash
   cd /opt/mpc-coordinator && docker compose up -d
   ```
   ```bash
   docker logs --tail 50 mpc-coordinator-mpc-coordinator-1
   ```
   With Ansible: `ansible-playbook 04-coordinators.yml --limit <host>`.
3. **Check:** Coordinator UP on the MPC signer dashboard.

### MpcNodeDown

**Warning.** A coordinator can't reach an MPC node for 1 minute. Signing works with 2 of 3;
**creating accounts and sections doesn't** (it needs all 3).

1. **Confirm:** *MPC nodes* table: down from **both** coordinators = the node; from **one** = the
   network between those two hosts.
2. **Fix:** node down: as in [MpcBelowThreshold](#mpcbelowthreshold) step 2 (that node's team).
   Network: test from the coordinator's host:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://192.168.68.137:7000/health
   ```
   Timeout: the firewall (`01-hosts.yml`) or the network.
3. **Check:** UP from both coordinators. Retry any account or section creation that failed.

### MpcPoolEmpty

**Warning.** No ready presignature for a big (hot) key for 2 minutes: signing falls back to the
slow path (~0.6 s per signature).

1. **Confirm:** *Pools of big keys*, *Presignatures generated per second*. After an MPC node or
   coordinator restart it is normal for a few minutes.
2. **Fix:** if it lasts:
   - one of the 3 nodes down slows presigning: [MpcNodeDown](#mpcnodedown);
   - signing faster than presigning (sustained load): add CPU to the MPC nodes, or raise
     `MPC_REFILL_CONCURRENCY` on the coordinators ([MPC signer](../components/mpc-signer.md));
   - after a node restart with many failed presigns, clear the pools on both coordinators so they
     refill cleanly ([MPC signer upgrade](mpc-signer-upgrade.md)).
3. **Check:** the pools climb back towards their targets.

### MpcSmallPoolsEmpty

**Warning.** More than half of the small pools (accounts from `/createaccount`) empty for 15 minutes.

1. **Confirm:** *Pools of small keys* far below the total target; *Keys per pool class*.
2. **Fix:** too many small keys for the presigning capacity:
   - move rarely used accounts to `none`: `POST /account/pool {"address": "0x…", "pool": "none"}`
     ([proxy API](../reference/proxy-api.md));
   - lower `MPC_POOL_TARGET_SMALL`, or raise `MPC_REFILL_CONCURRENCY` / `MPC_COMPUTE_THREADS` and
     the MPC nodes' CPU.
3. **Check:** fewer empty small pools.

### MpcPresignFailing

**Warning.** More than 5 presign sessions failed in 10 minutes.

1. **Confirm:** usually right after an MPC node or coordinator restart (it clears by itself in
   minutes). Otherwise read the coordinator log:
   ```bash
   docker logs --since 15m mpc-coordinator-mpc-coordinator-1 2>&1 | grep -iE "presign|fail|error" | tail -30
   ```
2. **Fix:** a node timing out: [MpcNodeDown](#mpcnodedown); network between MPC hosts; a node with
   different cluster settings after an upgrade ([MPC signer upgrade](mpc-signer-upgrade.md)).
3. **Check:** the alert clears 10 minutes after the last failure.

### MpcSignErrors

**Warning.** Signing requests failed for reasons other than the policy.

1. **Confirm:** MPC signer → *Failures*; the coordinator log:
   ```bash
   docker logs --since 15m mpc-coordinator-mpc-coordinator-1 2>&1 | grep -iE "sign|error" | tail -30
   ```
2. **Fix:** by cause: an unknown key (the account isn't in this cluster), a node timing out
   ([MpcNodeDown](#mpcnodedown)), Besu not answering for `eth_sendTransaction`
   ([BesuNodeDown](#besunodedown), RPC VIP).
3. **Check:** *Failures* back to 0.

### MpcPolicyRefusals

**Warning.** A transaction was refused by an MPC node's policy (value, gas, chain id or destination).

1. **Confirm** what was refused:
   ```bash
   docker logs --since 1h mpc-coordinator-mpc-coordinator-1 2>&1 | grep -i policy | tail -20
   ```
2. **Fix:** a caller's bug (wrong chain id, too large an amount): fix the caller. A legitimate
   transaction above the limit: the teams change the policy in `cluster.json`
   ([MPC signer in production](../deployment/mpc-signer-production.md)). Never loosen a policy for an
   unexplained refusal: it may be an attack.
3. **Check:** no new refusals.

---

## Proxy and Redis

### ProxyDown

**Critical.** The active proxy (through VIP `.151`) doesn't answer: applications can't send.

1. **Confirm:** where is the VIP, and is a proxy running there?
   ```bash
   ip -br a | grep 192.168.68.151
   ```
   ```bash
   docker ps --filter name=proxy-proxy
   ```
2. **Fix:**
   - keepalived should have moved the VIP to the other host and started its proxy: on both hosts,
     `journalctl -u keepalived --since "15 min ago"`.
   - The proxy container is on the VIP host but exits: `docker logs --tail 100 proxy-proxy-1`
     (bad `.env`, signer or Besu unreachable at start).
   - To bring everything back in order: `ansible-playbook 07-ha.yml`.
3. **Check:** `curl -s http://192.168.68.151:30000/status/senders` answers; *Proxy* UP.

### ProxySenderStalled

**Critical.** A sender's transactions are ready in the RPC node's pool, but blocks keep coming
without them: the validators don't have them.

1. **Confirm:** Proxy & Redis → *Senders needing attention*: that sender is **STALLED**.
2. **Fix:** restart **one** validator (it fetches the pool again and includes them), for example on
   h137:
   ```bash
   docker restart besu-val3-besu-1
   ```
   Make sure the validators have `tx-pool-max-future-by-sender=2000`.
3. **Check:** Mined OK, In flight falls back to 0.

### ProxyNonceGap

**Warning.** A nonce has been missing for more than 2 minutes; the sender's later transactions wait.

1. **Confirm:**
   ```bash
   curl -s http://192.168.68.151:30000/status/senders
   ```
   (the sender's `gap` and waiting transactions).
2. **Fix:** the proxy repairs gaps by itself (it resends or sends a filler). If it doesn't, the
   chain or the signer is the blocker: read `docker logs --since 15m proxy-proxy-1`, check
   [MpcBelowThreshold](#mpcbelowthreshold) and [BesuNoNewBlocks](#besunonewblocks).
3. **Check:** *Nonce gap since* back to 0.

### ProxyNonceRepaired

**Info.** The proxy repaired a gap: transactions were lost, or a filler was sent.

1. **Read** what happened: `docker logs --since 1h proxy-proxy-1 2>&1 | grep -i -E "repair|filler|gap"`.
2. **Act** only if it repeats: it points at lost transactions (an RPC node that dropped them, a
   restart in the middle of sending).

### ProxySenderCheckFailing

**Warning.** The proxy's background check can't read Besu for a sender, for 2 minutes.

1. **Confirm:** the RPC VIP from the proxy host:
   ```bash
   curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://192.168.68.150:8545
   ```
2. **Fix:** no answer: HAProxy and the RPC nodes (`curl -s http://127.0.0.1:8410/` on h135 / h136;
   [BesuNodeDown](#besunodedown)).
3. **Check:** the alert clears; the sender is back to OK in Proxy & Redis → *All senders*.

### ProxyHttpErrors

**Warning.** More than 5 % of answers are 5xx for 5 minutes.

1. **Confirm:** Proxy & Redis → *Errors per second*: which route, which code.
2. **Fix:** read the errors:
   ```bash
   docker logs --since 15m proxy-proxy-1 2>&1 | grep -iE "error|fail" | tail -30
   ```
   Typical: the signer down or slow (MPC alerts), Besu not answering (RPC VIP), the registry not
   answering for section calls.
3. **Check:** *5xx errors* back to 0 %.

### ProxySlow

**Warning.** 95th-percentile answer time above 5 s for 10 minutes (without `/createaccount` and
`/admin`).

1. **Confirm:** Proxy & Redis → *95th percentile by route*: which routes.
2. **Fix:** transfers and NFT sales slow: signing on the cold path ([MpcPoolEmpty](#mpcpoolempty)) or
   a slow RPC node (Besu → *JSON-RPC latency*); everything slow: the proxy itself
   ([ProxyEventLoopBlocked](#proxyeventloopblocked)) or the host ([HostMemoryHigh](#hostmemoryhigh)).
3. **Check:** *Latency p95* back under 1–2 s.

### ProxyEventLoopBlocked

**Warning.** The proxy's single Node.js thread was blocked for more than 1 s, for 5 minutes.

1. **Confirm:** *Event-loop delay* and *Memory* on Proxy & Redis; host CPU on Hosts.
2. **Fix:** the host short of CPU or memory: fix that ([HostMemoryHigh](#hostmemoryhigh)). The proxy's
   memory growing steadily: restart it on the VIP host (a few seconds of failed requests):
   ```bash
   cd /opt/besu-chain/proxy && docker compose restart proxy
   ```
3. **Check:** event-loop delay under 0.1 s.

### ProxyRedisDisconnected

**Warning.** The active proxy has no Redis connection for 5 minutes. It keeps working (memory +
chain) but loses its nonce cache on a restart.

1. **Confirm:** on the VIP host: `docker ps --filter name=proxy-redis`.
2. **Fix:**
   ```bash
   cd /opt/besu-chain/proxy && docker compose up -d redis
   ```
   The proxy reconnects by itself ("redis available again" in its log).
3. **Check:** Proxy & Redis → *Redis link* CONNECTED.

### RedisDown

**Warning.** The active proxy's Redis (or its exporter) doesn't answer for 2 minutes.

1. **Confirm:** Redis or only the exporter?
   ```bash
   docker ps --filter name=proxy-redis
   ```
2. **Fix:** Redis stopped: as [ProxyRedisDisconnected](#proxyredisdisconnected). Only the exporter:
   ```bash
   cd /opt/besu-chain/proxy && docker compose up -d redis-exporter
   ```
3. **Check:** Proxy & Redis → *Redis* UP.

### RedisMemoryHigh

**Warning.** Redis above 90 % of its `maxmemory` for 10 minutes (only when a maximum is set).

1. **Confirm:** *Memory and keys*.
2. **Fix:** raise `maxmemory`, or find what grows (`docker exec proxy-redis-1 redis-cli --bigkeys`).
   The proxy's keys are small; steady growth is unusual: report it.
3. **Check:** memory below the line.

---

## Sections

### SectionUpfrontEmpty

**Critical.** An enabled section's upfront account is at 0: it can't create accounts or pay −x.

1. **Confirm:** Sections dashboard → *Upfront accounts*; chainlens **Sections** page.
2. **Fix:** top it up from SENDER01: chainlens Sections page → the section → **Top up**, or:
   ```bash
   curl -s -X POST http://192.168.68.151:30000/admin/sections/<id>/topup \
     -H "Authorization: Bearer $(cat state/secrets/proxy_admin_token)" \
     -H 'Content-Type: application/json' -d '{"amount":"500"}'
   ```
   (from the operator, in `ansible/`). If SENDER01 is low too: [Sender01Low](#sender01low).
3. **Check:** the balance is above `upfront_low_balance_eth`.

### SectionUpfrontLow

**Warning.** An enabled section's upfront balance is below `upfront_low_balance_eth`.

1. **Fix:** top it up as in [SectionUpfrontEmpty](#sectionupfrontempty), before it runs out. To
   change the threshold: `upfront_low_balance_eth` in `settings.yml`, then
   `ansible-playbook 06-proxy.yml` (0 turns the alert off).

### Sender01Low

**Warning.** SENDER01 is below `sender01_low_balance_eth`; it funds every top-up.

1. **Fix:** collect the sections' money back: on the chainlens Sections page, **Sweep**
   (consumption → payment) then **Pay back** (payment → SENDER01) for each section. Otherwise fund
   SENDER01 from your treasury account.
2. **Check:** Sections dashboard → *SENDER01* above the threshold.

### SectionMetricsFailing

**Warning.** The proxy can't read the section balances for 10 minutes; the balance alerts are blind.

1. **Confirm:** `docker logs --since 15m proxy-proxy-1 2>&1 | grep -i section | tail` on the VIP host.
2. **Fix:** the SectionRegistry or Besu doesn't answer the proxy: check the RPC VIP
   ([ProxySenderCheckFailing](#proxysendercheckfailing) step 1) and `REGISTRY_CONTRACT` in
   `/opt/besu-chain/proxy/.env` (rerun `06-proxy.yml`).
3. **Check:** the Sections dashboard updates again.

---

## Hosts

### HostDown

**Warning.** A host's node-exporter doesn't answer for 2 minutes. Usually the whole host is down,
and the other alerts of that host follow.

1. **Confirm:** ping and SSH the host. Up but node-exporter down:
   ```bash
   docker ps -a --filter name=node-exporter
   ```
2. **Fix:** power it on, or start node-exporter (`ansible-playbook 01-hosts.yml --limit <host>`).
   Before restarting a host that misbehaved, keep its logs (`docker logs` of Besu and MPC) for
   the post-mortem. After it is back, bring its services in order:
   ```bash
   ansible-playbook 01-hosts.yml 05-besu.yml 07-ha.yml --limit <host>
   ```
   (plus `04-coordinators.yml` for h135 / h136). Expect `MpcPoolEmpty`, `MpcPresignFailing` and
   backup alerts to clear by themselves within an hour.
3. **Check:** Hosts table UP; every alert of that host cleared.

### HostMemoryHigh

**Warning.** More than 90 % of the host's memory really in use for 10 minutes.

1. **Confirm** what uses it:
   ```bash
   free -m; docker stats --no-stream
   ```
   ```bash
   ps aux --sort=-rss | head -15
   ```
2. **Fix:** a Besu node with a large heap: each may grow up to `besu_java_opts` (`-Xmx`); with two
   Besu nodes on h135 / h136, lower it (e.g. `-Xmx2g`) and run `05-besu.yml`. A process growing
   without limit: restart it and report. Long term: more RAM.
3. **Check:** memory under 90 % (Hosts dashboard).

### HostDiskFull

**Warning.** A filesystem is more than 80 % full for 10 minutes. A full disk stops Besu.

1. **Confirm:**
   ```bash
   df -h; docker system df
   ```
2. **Fix:**
   ```bash
   docker image prune -f && docker builder prune -f
   ```
   Old logs (`/var/log`, `journalctl --vacuum-size=500M`); old chain snapshots on h137 (`KEEP`
   in `snapshot-chain.sh`); on h139, Prometheus data (`prometheus_retention_size`). Then grow the
   disk if needed.
3. **Check:** under 80 %.

### HostClockNotSynced

**Warning.** The clock isn't synchronized, or is more than 100 ms off, for 10 minutes.

1. **Confirm:**
   ```bash
   chronyc tracking; chronyc sources
   ```
2. **Fix:** the NTP servers unreachable: firewall or `ntp_servers` in `settings.yml`, then
   `ansible-playbook 01-hosts.yml --limit <host>`; to step a large offset now: `chronyc makestep`.
3. **Check:** Hosts table: Clock SYNCED, offset under 50 ms.

---

## Backups

Each backup reports to the node-exporter of its own host: if that host is down, its backups look
missing. Fix [HostDown](#hostdown) first.

### BackupFailed

**Warning.** A backup's last failure is newer than its last success.

1. **Confirm:** Hosts → *Backups*: which backup, which host (Last run FAILED).
2. **Fix:** run it by hand and read the error:
   - chain snapshot (h137): `cd /opt/besu-val3 && ./snapshot-chain.sh /backup/chain` (log:
     `/var/log/besu-snapshot.log`);
   - MPC shares (each MPC host): `/opt/besu-chain/mpc-signer/deploy/node/backup.sh /secure/mpc-backup`
     (log: `/var/log/mpc-backup.log`);
   - node keys: `ansible-playbook 10-backups.yml`.
   Usual causes: disk full, the copy target (`snapshot_copy_to`) unreachable.
3. **Check:** Last run OK.

### ChainSnapshotTooOld

**Warning.** No chain snapshot for 2 days.

1. **Fix:** check the cron on h137 (`crontab -l | grep snapshot`) and its log, run it by hand as in
   [BackupFailed](#backupfailed). h137 down: no snapshot until it is back.

### ChainSnapshotMissing

**Warning.** No chain snapshot was ever recorded.

1. **Fix:** `ansible-playbook 10-backups.yml` (installs the daily cron and takes the first
   snapshot; val3 stops for a moment while its data is archived, the chain continues).

### MpcShareBackupTooOld

**Warning.** An MPC node's share backup is more than 2 hours old (it runs hourly at :07).

1. **Fix:** after a host was down this clears at the next hourly run; to clear it now, run the
   backup on that MPC host (as in [BackupFailed](#backupfailed)). Otherwise check the cron
   (`crontab -l | grep mpc`) and `/var/log/mpc-backup.log`.

### MpcShareBackupMissing

**Warning.** Fewer than 3 MPC nodes have a recorded share backup, for 1 hour.

1. **Fix:** an MPC host down: [HostDown](#hostdown). Backups not set up: each team runs `backup.sh`
   hourly, or set `mpc_backup_cron: true` and run `ansible-playbook 10-backups.yml`.

### ValidatorKeyBackupMissing

**Warning.** Not every validator has a recorded key backup. Losing 2 of 4 validator keys ends the
chain for good.

1. **Fix:** a validator host down: [HostDown](#hostdown). Otherwise set `key_backup_gpg_public_key`
   and run `ansible-playbook 10-backups.yml` ([GPG key](../deployment/gpg-key.md)). After a host was
   rebuilt, move its old file out of `state/key-backups/` and run `10-backups.yml` again.
2. **Check:** Hosts → *Backups* lists a validator-key backup for val1–val4.
