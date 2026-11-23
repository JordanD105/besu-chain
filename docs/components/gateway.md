# Section gateway

> **What:** the optimistic section gateway (`gateway/`): one small service per section, next to its
> application. It speaks the proxy's application API; while the proxy can't be reached it answers by
> itself from a local ledger and queues the writes, then sends them when the link is back.
>
> **For:** operators (deploying it), application developers (calling it), business admins (the
> single-writer rule during a cut).
>
> **Related:** [proxy API](../reference/proxy-api.md) · [sections](../features/sections.md) ·
> [alerts](../operations/alerts.md#7-section-gateways-gatewayyml) · [Ansible](../deployment/ansible.md)

**Contents**

- [At a glance](#at-a-glance)
- [Why](#why)
- [How it works](#how-it-works)
- [What works offline](#what-works-offline)
- [The single-writer rule](#the-single-writer-rule)
- [Spare accounts](#spare-accounts)
- [Safe retries: `X-Request-Id`](#safe-retries-x-request-id)
- [The gateway's own routes](#the-gateways-own-routes)
- [Corrections](#corrections)
- [Settings](#settings)
- [Deployment](#deployment)
- [Firewall](#firewall)
- [Monitoring](#monitoring)
- [Lab test](#lab-test)
- [Known limits](#known-limits)
- [Files](#files)

---

## At a glance

| | |
|---|---|
| **URL** | `http://<gateway host>:30010`, the same routes as the proxy (`/transfer`, `/createaccount`, `/contract/*` …) |
| **Caller** | the section's application, with the section's key (`X-Section-Key: sk_…`) |
| **One per** | section (`gateway_section: <id>` on a host of `gateway_hosts`) |
| **Program** | `gateway/gateway.js`: Node.js 22, no npm packages (`node:http`, `node:sqlite`, `fetch`) |
| **Image** | `localhost/besu-gateway/gateway` (built by `02-images.yml`), container user uid 1000 |
| **Data** | `/var/lib/besu-gateway/gateway.db` (SQLite: ledger, queue, spare accounts, reports) |
| **Settings** | `/etc/besu-gateway/gateway.json` and `section.key`, written by `14-gateway.yml` |
| **Off by default** | `gateway_enabled: false` in `settings.yml` |

## Why

A section's application normally calls the proxy on the VIP `.151:30000`. If the link between the
application's host and the proxy breaks (a switch, a firewall change, a cut between two buildings),
the application stops: no payments, no item sales, no reads.

With a gateway next to the application, **the application keeps working while it and its host are
cut from the proxy**: the gateway answers from what it knows, queues the writes, and sends them in
order when the link is back. It is *optimistic*: it promises that a queued write will happen, and if
the chain refuses it later, it undoes it in its ledger and tells the application (a
[correction](#corrections)).

This works because **only the gateway moves the section's money** during a cut
([the single-writer rule](#the-single-writer-rule)): its ledger knows every balance, so a queued
payment never lacks the money.

## How it works

The gateway is always in one of three modes (`GET /gateway/status`, metric `gateway_mode`):

| Mode | Writes | Reads |
|---|---|---|
| **online** (0) | passed through to the proxy; the ledger is updated from the chain after each one | passed through; each answer is cached |
| **offline** (1) | answered by the gateway from its ledger and queued | from the ledger (platform collections) or the last cached answer |
| **draining** (2) | the queue is sent in order; new writes are answered from the ledger and queued behind it | as offline |

### Online: pass-through and the ledger

Every request goes to the proxy with the section's key, and the proxy's answer goes back unchanged.
Meanwhile the gateway keeps a local **ledger**:

- **balances** of the section's accounts (upfront, consumption, payment and the user accounts it
  knows), read from the chain every `sync_seconds` (30 s) and after each write;
- the **items** of the platform collections (avatars and nicknames: owner, price, level, payments,
  undo deadlines), read from the collections' events;
- the **last answer of every read** (cache), for the reads it cannot compute itself.

It also keeps a stock of [spare accounts](#spare-accounts) and delivers pending
[corrections](#corrections).

### Offline: answers and the queue

The gateway checks the proxy every `health_check_seconds` (`GET /contract/list?type=none`, 3 s
timeout). After `offline_after_failures` failed checks in a row it goes **offline**. A write that
fails because the link dropped during the request switches it offline at once.

Offline, each write is checked against the ledger (the account is a known user of the section, the
balance is enough, the item is for sale, the undo period is open, the [limits](#offline-limits)),
then **applied to the ledger, queued, and answered** like the proxy would answer, plus a `gateway`
field. The `txHash` is a temporary hash (`sha256("gateway:" + request id)`) until the real one exists:

```json
POST http://<gateway host>:30010/transfer   { "account": "0xUser", "amount": "0.2", "memo": "offline +x" }
→ { "success": true, "section": { "id": 1, "name": "Shop B" }, "direction": "account -> consumption",
    "from": "0xUser", "to": "0xConsumption", "amount": "0.2", "memo": "offline +x",
    "txHash": "0x1789…f124",
    "gateway": { "mode": "offline", "queued": true, "request": "d8498d08-…" } }
```

### Draining: sending the queue

The first successful check after a cut switches the gateway to **draining** (or straight to online
when nothing is queued). It sends the queue **one request at a time, in order**:

| Step | What |
|---|---|
| **Nonce check** | before sending, it records the signer's nonce. A request whose earlier send has no answer (the link dropped, `uncertain`) is not sent twice: if the signer's nonce moved past the recorded one, the gateway finds that transaction in the last 60 blocks and marks the request done |
| **Sent** | the proxy answers 200: the request is `done`, with its real transaction hash |
| **Proxy error** (5xx, link down) | the request stays `uncertain`; the next round checks the nonce and retries |
| **Conflict** (4xx: the chain or the proxy refuses it) | the request is `failed`; its effect is **undone in the ledger**; later queued requests on the **same item** are `cancelled` (undone too); a report is written and sent to the correction webhook |
| **Reconcile** | when the queue is empty, a full sync reads every balance and item from the chain; any difference against the ledger is written to the report (`reconcile`); then the gateway is **online** |

`GET /transfer/<temporary hash>` answers `pending` (or `failed`) while the request is queued, and,
once sent, the proxy's answer for the real transaction.

### Modes and timing

| | Time |
|---|---|
| link refused (connection refused, host unreachable) → offline | about `offline_after_failures` × `health_check_seconds` (lab: 7.9 s with 3 × 2 s) |
| packets silently dropped → offline | longer: each check waits its 3 s timeout, and a sync running in the same loop waits too (lab: 22.4 s, [known limits](#known-limits)) |
| link back → online (nothing queued) | the next check (lab: 0.7–1.6 s) |
| link back → draining → online | the next check, then the time to send the queue and one full sync |

The mode, the queue and the ledger are on disk: a restart of the gateway keeps them.

## What works offline

### Routes

| Route | Offline |
|---|---|
| `POST /transfer` | **+x** (user → consumption) and **−x** (upfront → user), for user accounts the gateway knows; balance checked in the ledger |
| `POST /createaccount` | hands out a [spare account](#spare-accounts); the funding from the upfront account and the pool class are queued. `registryTxHash` is `null` (the spare is already registered) |
| `POST /account/pool` | queued |
| `POST /contract/send` | the platform collections (table below); other contracts only when listed in `contract_send_allowed` |
| `POST /contract/call` | the platform collections from the ledger (table below); any other call: the last cached answer of the same contract, function and arguments, or an error. A batch (`calls`) answers each call on its own |
| `GET /transfer/:txHash` | the gateway's temporary hashes: `pending` / `failed`; other hashes: 503 |
| other reads (`GET /contract/list`, `POST /contract/events`, …) | the last cached answer of the same request, with `gateway.cachedAt`; never asked online: 503 |

A user account is "known" when it was in the section at the last run of `14-gateway.yml`, or was
created through the gateway. Accounts made elsewhere since (the chainlens Sections page, a keyless
call) are refused offline (403) until `14-gateway.yml` runs again.

### Platform contract functions

The avatar and nickname collections registered in the SectionRegistry (`/contract/list?type=avatar`
and `type=nickname`):

| Function | Offline |
|---|---|
| `buy` (by `tokenId`, `imageUrl` or `nickname`) | **write:** the item must be unsold in the ledger; the price is paid user → consumption; the undo deadline starts now. The queued request carries that price: if the center changes it meanwhile, the buy becomes a [correction](#corrections), never a different payment |
| `upgradeLevel` (nicknames) | **write:** owner only, level only up, every level on the way for sale |
| `undo` | **write:** within the undo period: the consumption account refunds everything paid for the item, which goes back to the center |
| `undoLevel` (nicknames) | **write:** the newest level upgrade, within its undo period |
| `ownerOf`, `priceOf`, `imageOf`, `nicknameOf`, `levelOf`, `tokenURI`, `paymentsOf`, `tokensOf`, `balanceOf`, `tokenOf`, `levelCount`, `levelInfo`, `quote`, `holdSeconds`, `totalSupply`, `minter`, `name`, `symbol` | **read** from the ledger, with `gateway.fromLedger: true` (offline payments show `pending: true`) |
| any other function (`mint`, `setPrice`, `addLevel`, …) | refused (503): admin work is done on the main side |

### Refused offline

| Refusal | Status |
|---|---|
| admin work (`mint`, `setPrice`, levels…; the admin API is never served by the gateway) | 503 |
| a contract that is not a platform collection, unless `"0xContract:function"` is in `contract_send_allowed` (queued with no ledger check: the result is `null`) | 503 |
| an operation not in `offline_operations` | 503 |
| a limit reached ([below](#offline-limits)), or no spare account left | 503 |
| an account that isn't a known user of the section | 403 |
| not enough balance in the ledger | 400 |
| item already sold, undo period over | 409 |
| a read never asked while online | 503 |

### Offline limits

| Setting | Limit |
|---|---|
| `offline_max_hours` (24) | after this long offline, no more optimistic answers (503) |
| `offline_total_eth` (100) | all the money the section's queued requests move during one cut |
| `offline_per_account_eth` (20) | the money one paying account moves during one cut. **The paying account** is the user for +x and buys, the **upfront** account for −x and new accounts, the **consumption** account for undos |
| `offline_operations` | which kinds of write are answered offline |

## The single-writer rule

During a cut, **the gateway is the only one that may move the section's money.** Its ledger assumes
it: a top-up, sweep, pay back, transfer, new account or account change made on the main side (the
chainlens Sections page, the admin API, a keyless call) is invisible to it, and can make queued
requests fail when they are sent (a sweep empties the consumption account an undo pays from).

- **Admins:** make no writes on that section while its gateway is offline or draining. Changes of the
  center to the collections (a new price, a sale made on the main side) are handled, but each one
  can turn queued requests into [corrections](#corrections).
- **Chainlens:** the **Sections** page shows a red notice per section whose gateway is not online
  (`GET /api/sections/gateways`, from `GATEWAYS` in `chainlens/.env`): *"its gateway cannot reach the
  proxy (offline since …, N queued) … make no admin writes on this section … until it is back"*, or
  that the gateway does not answer at all.
- **Alert:** [GatewayOffline](../operations/alert-runbook.md#gatewayoffline) fires after 1 minute.

## Spare accounts

`/createaccount` needs all 3 MPC nodes (key generation), which the gateway can't reach during a cut.
So while **online with nothing queued**, the gateway creates accounts in advance through the proxy
(`/createaccount` with the section's key, amount `0`, pool `none`: registered under the section),
one per round, until it has `spare_accounts` (20). Offline, `/createaccount` hands out the oldest
spare, queues its funding as a −x transfer and its pool class (`small` by default) as an
`/account/pool` request.

`GatewaySparesLow` fires when fewer than `spare_alert_below` (5) are left for 30 minutes. With none
left, `/createaccount` offline answers 503.

## Safe retries: `X-Request-Id`

Send a unique `X-Request-Id` (up to 100 characters) with each write. If the application retries a
request the gateway has queued (a timeout on its side, a restart), the gateway returns the **first
answer** with `gateway.repeated: true` and does not queue it again:

```bash
curl -s -X POST http://<gateway host>:30010/transfer -H "X-Section-Key: sk_…" \
  -H "X-Request-Id: order-1234" -H 'Content-Type: application/json' -d '{"account":"0xUser","amount":"0.01"}'
# again with the same X-Request-Id → the same answer, "gateway": { "request": "order-1234", "status": "queued", "repeated": true }
```

The id is remembered only for requests the gateway **queued** (offline, draining, or cut during the
request). An online pass-through write is not remembered: a retry is sent to the proxy again. For an
offline `/createaccount` with amount `0`, a retry hands out another spare. Without the header the
gateway makes its own id (shown in `gateway.request`).

## The gateway's own routes

| Route | Key | Answer |
|---|---|---|
| `GET /gateway/status` | no | `section`, `mode`, `since` (start of the cut), `queue`, `oldestSeconds`, `spares`, `offlineEth` (spent during this cut), `conflicts`, `lastSync`, `limits` |
| `GET /gateway/request/:id` | yes | one queued request by its id or temporary hash: `status` (`queued`, `sending`, `uncertain`, `done`, `failed`, `cancelled`), `txHash` (the real one once sent), `error`, `created` |
| `GET /gateway/report?since=<ISO time>` | yes | the last 500 reports, newest first: `conflict` and `reconcile` entries, with `delivered` |
| `GET /metrics` | no | Prometheus metrics ([monitoring](#monitoring)) |

Every other route needs the section's key (401 otherwise, after 0.5 s).

## Corrections

A **correction** is a queued request the chain refused after the link came back. The gateway undoes
it in its ledger, writes a `conflict` report, and, when `correction_webhook` is set, POSTs it to the
application (retried every round while online until it answers 2xx; reports are kept
`report_keep_days`):

```json
{ "id": "d8498d08-…", "section": 1, "at": "2026-11-23T17:51:…Z",
  "request": "d8498d08-…", "txHash": "0x…(the temporary hash the application got)",
  "operation": "nickname_buy", "path": "/contract/send", "body": { "contract": "0xNicknames", "function": "buy", "args": { "tokenId": "2" }, "from": "0xUser" },
  "promised": { "tokenId": "2", "nickname": "Ben", "buyer": "0xUser", "paid": "0.2", "undoUntil": "…" },
  "result": "failed", "reason": "token 2 is already sold",
  "refund": [ { "account": "0xUser", "amount": "0.2" } ],
  "cancelled": [ "50e6ad6b-…" ] }
```

`refund` is what the ledger gave back (the money never left on chain); `cancelled` lists the later
requests on the same item that were dropped with it (here a level upgrade of that nickname). The
application should tell its user and undo what it gave on its side.

## Settings

In `ansible/group_vars/all/settings.yml`:

| Setting | Default | Meaning |
|---|---|---|
| `gateway_enabled` | `false` | turns the gateways on (images, firewall, `14-gateway.yml`, Prometheus targets, chainlens notice) |
| `gateway_port` | `30010` | the host port of every gateway |
| `gateway_client_ips` | `[]` | who may call the gateways: the applications (addresses or networks) |
| `gateway_sections` | `{}` | per section id, only the values that differ from `gateway_defaults`, e.g. `{ 1: { offline_total_eth: 150 } }` |

`gateway_defaults`:

| Setting | Default | Meaning |
|---|---|---|
| `health_check_seconds` | `3` | how often it checks the proxy (one round of the loop) |
| `offline_after_failures` | `3` | failed checks in a row → offline |
| `offline_max_hours` | `24` | after this long offline: no more optimistic answers (503). Keep it far below the undo period (7 days) |
| `offline_total_eth` | `100` | all the section's payments during one cut |
| `offline_per_account_eth` | `20` | one paying account during one cut |
| `offline_operations` | `[transfer, createaccount, avatar_buy, nickname_buy, level_upgrade, undo, account_pool]` | the writes answered offline (`undo` covers `undo` and `undoLevel`) |
| `contract_send_allowed` | `[]` | other contracts' writes allowed offline: `"0xContract:function"` |
| `spare_accounts` | `20` | accounts created in advance, for `/createaccount` offline |
| `spare_alert_below` | `5` | `GatewaySparesLow` below this |
| `correction_webhook` | `""` | the application's URL that receives the corrections (`""` = report only) |
| `report_keep_days` | `365` | how long reports are kept |
| `sync_seconds` | `30` | how often it reads the chain while online |

**To change a setting:** edit `settings.yml`, then `ansible-playbook 14-gateway.yml`. It rewrites
`gateway.json` and recreates the container; the ledger, the queue, the spare accounts and the
reports in `/var/lib/besu-gateway` are kept. A change of `gateway_port` or `gateway_client_ips` also
needs `01-hosts.yml` (the firewall); of `gateway_port`, `09-monitoring.yml` and `11-chainlens.yml` too.

## Deployment

1. **Choose the host** next to the section's application (a host of `servers` in
   `ansible/inventory.yml`) and name its section:

   ```yaml
   gateway_hosts: { hosts: { h137: { gateway_section: 1 } } }
   ```

2. **Turn it on** in `settings.yml`: `gateway_enabled: true`, and the applications' addresses in
   `gateway_client_ips`.
3. **The section key.** The gateway uses the section's key, and the application calls the gateway
   with the **same** key. Either put the section's current key in
   `ansible/state/secrets/gateway-section-<id>.key` (one line), or let Ansible make a new one:
   `-e gateway_new_key=true` (the old key stops at once: switch the application to the gateway at the
   same time).
4. **Apply** (from `ansible/`):

   ```bash
   ansible-playbook 01-hosts.yml 02-images.yml 14-gateway.yml -e gateway_new_key=true   # first time, new key
   ansible-playbook 09-monitoring.yml 11-chainlens.yml                                   # targets, chainlens notice
   ```

   `14-gateway.yml` reads the section and its user accounts from the proxy admin API, writes
   `/etc/besu-gateway/gateway.json` and `section.key`, starts the container and waits for
   `/gateway/status`. It prints the mode and the number of spare accounts (they are made over the
   next minutes, while online).
5. **Point the application** at `http://<gateway host>:30010` instead of the proxy. Nothing else
   changes in its calls.

`site.yml` runs `14-gateway.yml` (when `gateway_enabled`) before `09-monitoring.yml`, so Prometheus
finds the gateways answering. After a change to `gateway/`: `01-hosts.yml 02-images.yml 14-gateway.yml`.

## Firewall

`ha/firewall-layout.sh` (phase `01-hosts.yml`) opens, when `gateway_enabled`:

| Port | From | On |
|---|---|---|
| 30010 (`GATEWAY_PORT`) | `gateway_client_ips`, the monitoring host (Prometheus, chainlens), `operator_ip` | the gateway hosts (`HAS_GATEWAY=1`) |
| 30000 (proxy VIP) | the gateway hosts (added to `PROXY_CLIENTS`) | the HA pair |
| 8545 (RPC VIP) | the gateway hosts (`GATEWAYS`: balances, nonces) | the HA pair |

The application then needs only `gateway_client_ips`, not `proxy_client_ips`.

## Monitoring

Prometheus job `gateway` (targets from the IP plan: `name: gateway-<section id>`), metrics from
`GET /metrics`, labels `section_id` and `section`:

| Metric | Meaning |
|---|---|
| `gateway_mode` | 0 online, 1 offline, 2 draining |
| `gateway_queue_length` | requests waiting to be sent |
| `gateway_queue_oldest_seconds` | age of the oldest waiting request |
| `gateway_offline_eth` | ETH spent during the current cut |
| `gateway_spare_accounts`, `gateway_spare_target` | spare accounts left, and wanted |
| `gateway_spare_alert_below` | the `GatewaySparesLow` threshold |
| `gateway_conflicts_total` | queued requests the chain refused after reconnecting |
| `gateway_last_sync_timestamp_seconds` | the last full sync with the chain |

Alerts (`monitoring/prometheus/rules/gateway.yml`, [alerts](../operations/alerts.md#7-section-gateways-gatewayyml)):

| Alert | Severity | Wait | Fires when |
|---|---|---|---|
| [GatewayOffline](../operations/alert-runbook.md#gatewayoffline) | warning | 1 min | the gateway can't reach the proxy |
| [GatewayDrainingLong](../operations/alert-runbook.md#gatewaydraininglong) | warning | 15 min | still sending its queue |
| [GatewayQueueOld](../operations/alert-runbook.md#gatewayqueueold) | warning | 5 min | a queued request is older than 1 hour |
| [GatewaySparesLow](../operations/alert-runbook.md#gatewayspareslow) | warning | 30 min | fewer spare accounts than `spare_alert_below` |
| [GatewayConflicts](../operations/alert-runbook.md#gatewayconflicts) | warning | – | queued requests were refused in the last hour |
| [GatewayDown](../operations/alert-runbook.md#gatewaydown) | critical | 2 min | the gateway doesn't answer |

## Lab test

On the lab layout (`10.77.0.x`), one gateway on h137 for section 1 ("Shop B"), with
`health_check_seconds: 2`, `offline_after_failures: 3`, `spare_accounts: 3`. The link was cut with
iptables on h137 to both VIPs (the proxy and the RPC); the operator was never cut.

| Step | Done | Result |
|---|---|---|
| 1. Online | status, spare accounts filled to 3, a call without the key | (output not kept) |
| 2. Through the gateway | a new account 0xUser (3 ETH), +x 0.5; on the main side the center deployed an avatar and a nickname collection, minted 3 avatars (0.1) and 3 nicknames (0.2), 2 levels (0.05, 0.1); an account 0xOther was made at the proxy | (output not kept); step 4 shows the ledger knew the new items |
| 3. Cut | REJECT to both VIPs | offline (output not kept) |
| 4. Offline answers | a new account 0xUser2 (1 ETH, a spare), +x 0.2, −x 0.3, avatar 1 bought by image URL, nickname "Ann" bought by name, level 0 → 1 → 2, `undoLevel`, reads (`tokensOf`, `paymentsOf`), `GET /transfer/<temp hash>`, the same `X-Request-Id` twice | all answered at once; `pending` for the temporary hash; the retry got the first answer |
| 4. (refusals) | avatar 1 again (by 0xUser2), +x 50 by 0xUser2, `mint` | 409 *already sold*; 503 *the offline limit of 0xUser2 (20 ETH) is reached*; 503 *admin work is done on the main side* |
| 5. Conflicts set up on the main side | the center repriced avatar 3 to 0.15; 0xOther bought nickname "Ben" at the proxy. Then offline: 0xUser bought avatar 3 (at 0.1) and "Ben", and upgraded "Ben"; 0xUser2 bought "Cat" | the gateway answered them (it could not know); queue 14, `offlineEth` 2.61 |
| 6. Link back | iptables rules removed | draining, then online; queue 0; the temporary hash of the +x 0.2 now answered with its real transaction |
| 7. Chain and report | owners, levels, balances; `/gateway/report`; `/metrics` | as the ledger promised, except the 2 conflicts |

**The two conflicts** (both reported with their refund):

| Request | Reason | Refund | Cancelled |
|---|---|---|---|
| avatar 3 bought at 0.1 | `value: the price is 0.15 ETH` | 0.1 to 0xUser | – |
| nickname "Ben" bought | `token 2 is already sold` | 0.2 to 0xUser | the queued level upgrade of "Ben" |

**The reconcile difference:** one account, the consumption account: ledger 48.27, chain 48.47. The
0.2 is 0xOther's purchase of "Ben" made at the proxy during the cut, which the gateway could not see:
exactly what [the single-writer rule](#the-single-writer-rule) is about. Final balances matched the
ledger: 0xUser 2.24, 0xUser2 0.8.

**Detection** (`health_check_seconds: 2`, `offline_after_failures: 3`):

| Cut | Offline after | Online again after |
|---|---|---|
| connection refused (REJECT) | 7.9 s | 1.6 s |
| packets silently dropped (DROP) | 22.4 s | 0.7 s |

## Known limits

Not built yet; the fixes are proposals.

| Limit | Effect | Proposed fix |
|---|---|---|
| **The health check shares its loop** with the sync and the spare-account creation | a busy gateway (a sync or a `/createaccount` waiting on a silent cut) checks late: a silent cut is detected later (22.4 s in the lab instead of ~8 s) | run the health check on its own timer, and give the sync's calls short timeouts |
| **A pass-through write just before a silent cut** waits for the proxy's answer up to 120 s | the application waits up to 2 minutes before the gateway answers it from its ledger (the request is then queued as `uncertain` and nonce-checked before it is resent) | a shorter answer timeout for pass-through writes, or answer from the ledger as soon as the health check declares the cut |

Also by design: accounts made outside the gateway are unknown offline until `14-gateway.yml` runs
again; `X-Request-Id` protects only queued requests; reads never asked online can't be answered
offline.

## Files

| File | What |
|---|---|
| [`gateway/gateway.js`](../../gateway/gateway.js) | the program |
| [`gateway/Dockerfile`](../../gateway/Dockerfile), [`gateway/docker-compose.yml`](../../gateway/docker-compose.yml) | the image (`node:22-alpine`) and the container (port, `/config`, `/data`) |
| [`ansible/14-gateway.yml`](../../ansible/14-gateway.yml) | deployment: section, key, settings, container |
| [`ansible/group_vars/all/settings.yml`](../../ansible/group_vars/all/settings.yml) | `gateway_enabled`, `gateway_port`, `gateway_defaults`, `gateway_sections`, `gateway_client_ips` |
| [`ansible/inventory.yml`](../../ansible/inventory.yml) | `gateway_hosts` with `gateway_section` |
| [`ha/firewall-layout.sh`](../../ha/firewall-layout.sh) | `GATEWAYS`, `HAS_GATEWAY`, `GATEWAY_CLIENTS`, `GATEWAY_PORT` |
| [`ansible/templates/targets/gateway.yml.j2`](../../ansible/templates/targets/gateway.yml.j2) | Prometheus targets |
| [`monitoring/prometheus/rules/gateway.yml`](../../monitoring/prometheus/rules/gateway.yml) | the 6 alerts |
| [`ansible/templates/chainlens.env.j2`](../../ansible/templates/chainlens.env.j2) | `GATEWAYS` for the chainlens notice |
| On the gateway host | `/etc/besu-gateway/gateway.json`, `/etc/besu-gateway/section.key`, `/var/lib/besu-gateway/gateway.db`, `/opt/besu-chain/gateway/.env` |
| On the operator | `ansible/state/secrets/gateway-section-<id>.key` |
