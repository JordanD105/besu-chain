# Troubleshooting

> **What:** symptoms you may see, their usual cause, how to check and how to fix. Organized by symptom.
>
> **For:** operators on duty.
>
> **Related:** [alerts](alerts.md) · [Grafana dashboards](dashboards.md) · [disaster recovery](disaster-recovery.md) · [architecture](../overview/architecture.md)

**Contents**

- [First checks](#first-checks)
- [Chain](#chain)
- [RPC and the RPC VIP](#rpc-and-the-rpc-vip)
- [Signing and accounts](#signing-and-accounts)
- [Proxy and transactions](#proxy-and-transactions)
- [Sections and avatars](#sections-and-avatars)
- [Hosts](#hosts)
- [Deployment (Ansible)](#deployment-ansible)
- [Collecting information](#collecting-information)

---

## First checks

1. **Grafana → Besu production → Alerts:** start with the **critical** alerts, then look for a
   `HostDown` or `BesuNodeDown` that explains the others ([reading an incident](alerts.md#reading-an-incident)).
2. **Nodes table:** every node UP, IN SYNC, 5 peers, last block age under 1 s.
3. **Where are the VIPs?** On h135 and h136: `ip -br a | grep -E '192\.168\.68\.15[01]'` (one host holds both).
4. **RPC nodes as HAProxy sees them** (h135 or h136): `curl -s http://127.0.0.1:8410/`.

## Chain

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| No new blocks (`BesuNoNewBlocks`) | fewer than 3 validators online | Nodes table, `BesuValidatorQuorumLost` | bring validators back; if blocks don't resume once 3+ are up, restart all validators together ([Besu manual](../deployment/besu-manual.md)) |
| One node's height stays flat, others climb (`BesuNodeStalled`, Sync **STALLED**) | it stopped importing: lost or broken peer connections; it may still say "in sync" | Nodes table: Behind, Last block age, Peers | RPC node: restarted automatically after 5 min; otherwise `docker restart besu-<node>-besu-1` |
| A node has 0–1 peers (`BesuPeersLow`) | network or firewall between hosts, or the other hosts are down | `curl` its `net_peerCount`; firewall rules (`firewall-cmd --list-rich-rules`) | fix the network; peers reconnect by themselves (static nodes) |
| `BesuUnpermittedPeers` | a node not in `permissions_config.toml` tries to connect | node log | ignore an unknown machine; for your own node, check its key / IP |

## RPC and the RPC VIP

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| Applications or chainlens see old balances or blocks | the RPC VIP serves a stalled node | `curl -s http://127.0.0.1:8410/` on h135 / h136 | the health check removes a stalled node; if both RPC nodes are stalled the freshest one keeps serving (degraded): restart them |
| `curl` to `.150:8545` hangs | HAProxy not running, or no host holds the VIP | `systemctl status haproxy keepalived`; `journalctl -u keepalived` | start them; `ansible-playbook 07-ha.yml` |
| `besu-rpc-health` not answering | service stopped | `systemctl status besu-rpc-health`; `journalctl -u besu-rpc-health` | `systemctl restart besu-rpc-health` |

## Signing and accounts

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| `/createaccount` or "create section" fails | key generation needs **all 3** MPC nodes | `MpcNodeDown`; MPC signer dashboard | bring the missing MPC node back, retry |
| Every signature fails (`MpcBelowThreshold`) | fewer than 2 MPC nodes reachable | MPC signer dashboard | bring MPC nodes back |
| Signing slow (seconds) | presignature pools empty (`MpcPoolEmpty`) after a restart or a burst | Pools panels | wait for the refill; if it lasts, more CPU or higher refill concurrency |
| A transaction is refused (`MpcPolicyRefusals`) | outside an MPC node's policy (value, gas, chain id, destination) | coordinator log | fix the caller, or the policy if the transaction is legitimate |
| `MpcPresignFailing` after a restart | a node still loading | coordinator log | clears by itself in a few minutes |

## Proxy and transactions

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| Applications get connection errors | proxy down, VIP .151 moving | `ProxyDown`; `docker ps` on the VIP host | keepalived starts the other proxy; check `journalctl -u keepalived` |
| A proxy container on the **standby** host shows `Exited (137)` | expected: keepalived stops any proxy on the host without the VIP (Docker restarts it at boot) | `journalctl -u keepalived` ("proxy running without the proxy VIP") | nothing |
| Transactions sent but never mined (`ProxySenderStalled`) | the validators don't have them in their pool | Proxy & Redis → *Senders needing attention* | restart **one** validator |
| A sender's transactions wait (`ProxyNonceGap`) | a missing nonce | `GET /status/senders`; proxy log | the proxy repairs it within ~30 s; otherwise read the log |
| `redis unavailable` in the proxy log | Redis not ready at start, or down | `ProxyRedisDisconnected` | harmless for correctness; restart Redis |

## Sections and avatars

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 X-Section-Key is required` | the call needs the section's key | send `X-Section-Key: sk_…` |
| `403 … is not an account of section "…"` | the account belongs to another section (or none) | use an account created with that section's key |
| `403 section "…" is disabled` | the section was disabled | enable it on the chainlens Sections page |
| Section can't create accounts (`SectionUpfrontEmpty` / `Low`) | upfront account empty | top up on the Sections page |
| Avatar sale: `wrong price` / insufficient funds | the buyer has less than price + gas | send the buyer ETH (−x) |
| `not minter` | `mint` sent through `/contract/send`, or the collection was not deployed by the contract account center | mint with `POST /admin/contract/send`; deploy collections through chainlens or the `avatar-collection` template |
| `410 … was removed: use …` | an old `/nft/*`, `/nickname/*` or `/admin/nickname/*` route | use the call the message names ([removed routes](../reference/proxy-api.md#removed-routes)) |

## Hosts

| Symptom | Check | Fix |
|---|---|---|
| `HostMemoryHigh` | `free -m`; `docker stats --no-stream`; `ps aux --sort=-rss \| head` | find the process; each Besu node may grow its heap up to `besu_java_opts` (`-Xmx`) |
| `HostDiskFull` | `df -h`; `docker system df` | `docker image prune`; old logs; grow the disk (a full disk stops Besu) |
| `HostClockNotSynced` | `chronyc tracking` | fix NTP (`ntp_servers` in settings) |
| After a host restart: backup alerts (`…BackupMissing`, `…TooOld`) | the host's backup records were unreachable | clear after the next backup run (hourly for MPC shares) |

## Deployment (Ansible)

| Symptom | Cause | Fix |
|---|---|---|
| "hosts have older code than this checkout" | ran a phase after `git pull` without phase 01 | run `01-hosts.yml` first |
| Image missing / `Unable to find image` | images not built or archive missing | run `02-images.yml`; with `image_archives_dir`, add the archive (`save-images.yml`) |
| A phase fails right after hosts restarted | services still starting | run the phase again |

## Collecting information

```bash
docker ps -a --format '{{.Names}} {{.Status}}'           # what runs on a host
docker logs --since 30m <container> 2>&1 | grep -iE "error|fail|exception" | tail -50
journalctl -u keepalived -u haproxy -u besu-rpc-health --since "30 min ago" --no-pager
free -m; df -h
```

Send these with the time of the problem (UTC, or say your timezone; Grafana shows local time).
