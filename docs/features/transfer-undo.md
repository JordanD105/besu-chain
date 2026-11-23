# Transfer undo

> **What:** a section's **+x** or **−x** transfer can be undone: the full amount goes back, once,
> within 7 days. An ETH transfer can't be reversed on chain, so the undo is a second transfer back,
> sent through the small `TransferUndo` contract, which allows each transfer to be undone only once.
>
> **For:** application developers (`POST /transfer/undo`), business admins (the **Undo** button in
> chainlens), operators (settings, deployment).
>
> **Related:** [proxy API](../reference/proxy-api.md#post-transferundo--undo-a-transfer) · [sections](sections.md) ·
> [memos](memos.md) · [section gateway](../components/gateway.md)

**Contents**

- [Rules](#rules)
- [How it works](#how-it-works)
- [The API](#the-api)
- [Chainlens](#chainlens)
- [The gateway](#the-gateway)
- [Money and monitoring](#money-and-monitoring)
- [Deployment and settings](#deployment-and-settings)
- [Lab test](#lab-test)
- [Files](#files)

---

## Rules

| Rule | |
|---|---|
| **What** | a +x or −x of the section (memo type `transfer.in` / `transfer.out`), mined and successful |
| **Amount** | the full amount only |
| **How often** | once: the `TransferUndo` contract refuses a second undo, whichever proxy sends it |
| **When** | within `transfer_undo_days` (7) of the original's block |
| **Who** | the section's key (or the admin API / chainlens for that section) |
| **Not undoable** | admin moves (top-up, sweep, pay back: correct them with the opposite move), new-account funding, item purchases (they have their own undo), an undo itself |

| Original | Undo | Signed by |
|---|---|---|
| **+x**: user → consumption | consumption → user | the section's consumption account (as for item undos) |
| **−x**: upfront → user | user → upfront | the user account |

The account that pays back must have the amount (409 otherwise): the consumption account may have
been swept, or the user may have spent the −x money.

## How it works

```
POST /transfer/undo { txHash }
  proxy: the original is a +x / -x of this section, mined, at most 7 days old, not undone (undoneAt == 0)
  proxy → TransferUndo.undo(original, recipient)  value = the amount, signed by the payer (MPC)
  contract: undoneAt[original] == 0 ? record the block, forward the ETH, emit TransferUndone : revert "already undone"
```

The contract also checks that the caller is an account of a section (`SectionRegistry.accountKind`),
so nobody else can mark a transfer as undone. The undo transaction carries the memo
`transfer.undoIn` / `transfer.undoOut` with `undoOf` = the original's hash ([memos](memos.md)).

## The API

`POST /transfer/undo` with `X-Section-Key` (admin: `POST /admin/sections/:id/undo`):

```json
POST /transfer/undo  { "txHash": "0x…the +x…", "memo": "order 77 cancelled" }
→ { "success": true, "section": { "id": 1, "name": "Shop B" }, "undoOf": "0x…",
    "direction": "consumption -> account", "from": "0xConsumption", "to": "0xUser", "amount": "0.5",
    "txHash": "0x…the undo…", "memo": "order 77 cancelled", "memoType": "transfer.undoIn", … }
```

| Error | Status |
|---|---|
| not a +x / −x of this section (another section's, a top-up, an undo…) | 409 |
| already undone (with the block and the undo's hash) | 409 |
| older than `transfer_undo_days` | 409 |
| the payer lacks the amount | 409 |
| not found or not mined yet | 404 |
| no section key | 401 |
| the contract is not deployed | 503 |

`GET /transfer/:txHash` of a +x / −x adds `undoneBy: { block, txHash }` (or `null`).

## Chainlens

The section page's **History** has an **Undo** column:

| Row | Shows |
|---|---|
| a +x / −x within the undo period, not undone | an **Undo** button (asks for confirmation; the page's **Memo** field goes with it) |
| an undone transfer | **Undone**, a link to the undo |
| an undo | a link to the original |

A transaction page shows *Undone by* / *Undo of* links. The history now also lists the undos of −x
transfers (signed by the user account), found by their memo.

## The gateway

| Mode | Undo |
|---|---|
| online | passed to the proxy. A temporary hash (a transfer made while offline and sent since) is translated to the real one |
| offline, the original still queued | the original is **cancelled**: nothing goes on chain; `GET /transfer/<its hash>` answers `failed` ("undone before it was sent") |
| offline, the original already sent | the undo is queued and sent after the cut (the contract still allows it only once) |
| offline, a transfer the gateway doesn't know (made elsewhere) | 503 |

The operation name is `transfer_undo` in `offline_operations` (on by default).

## Money and monitoring

| Metric (`proxy_section_operations_total`, `proxy_section_amount_eth_total`) | op |
|---|---|
| undo of a +x | `transfer_in_undo` |
| undo of a −x | `transfer_out_undo` |

Grafana **Sections**: income = +x, sales and level upgrades **minus** the undos (now including
`transfer_in_undo`).

## Deployment and settings

| | |
|---|---|
| **Contract** | `TransferUndo` (`proxy/contracts/TransferUndo.sol`, artifact `proxy/transfer-undo.json`), deployed once by the contract account center: `06-proxy.yml` does it (`POST /admin/contract/deploy { "template": "transfer-undo" }`; 409 = exists) |
| `transfer_undo_days` | `7`: the undo period (proxy, chainlens, gateways) |

## Lab test

| Test | Result |
|---|---|
| +x 0.5 with memo, undo with memo | the user 2.5 → 3.0, consumption −0.5; memo `order 77 cancelled`, default `Shop B：撤销付款 0.5 ETH（已退款）`; the original shows `undoneBy` |
| the same undo again; an undo of the undo; of a top-up; without a key | 409 *already undone in block …*; 409; 409; 401 |
| −x 0.3, undo (`ko`) | the user 3.3 → 3.0, upfront +0.3; `Shop B: 0.3 ETH 지급 취소(반환)` |
| two undos of the same +x at the same time | one done, the other **reverted by the contract**; the user got 0.2 back once |
| gateway online undo | done |
| gateway offline: undo of a queued +x | cancelled, never sent; a second undo 409 |
| gateway offline: undo of a +x sent online before the cut | queued, sent after the cut; the user got 0.13 back; no correction |
| chainlens history | `undoneBy` / `undoOf` links; an undo through chainlens with a memo |
| metrics | `transfer_in_undo` 0.9 ETH, `transfer_out_undo` 0.3 ETH |

## Files

| File | What |
|---|---|
| [`proxy/contracts/TransferUndo.sol`](../../proxy/contracts/TransferUndo.sol), `proxy/transfer-undo.json` | the contract and its compiled artifact |
| [`proxy/stress-latest.js`](../../proxy/stress-latest.js) | `POST /transfer/undo`, `/admin/sections/:id/undo`, the template, `undoneBy` |
| [`gateway/gateway.js`](../../gateway/gateway.js) | offline undo (cancel or queue) |
| [`chainlens/public/app.js`](../../chainlens/public/app.js) | the Undo column and links |
| [`ansible/06-proxy.yml`](../../ansible/06-proxy.yml) | deploys the contract once |
