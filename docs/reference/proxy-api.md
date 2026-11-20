# Proxy API reference

> **What:** every endpoint of the proxy (`proxy/stress-latest.js`), with request bodies and answers.
>
> **For:** application developers and operators.
>
> **Related:** [proxy component](../components/proxy.md) · [sections](../features/sections.md) ·
> [NFT workflow](../features/nft-workflow.md) · [glossary](../glossary.md)

**Contents**

- [Conventions](#conventions)
- [Accounts and transfers](#accounts-and-transfers)
- [Section calls (`X-Section-Key`)](#section-calls-x-section-key)
- [NFT collections](#nft-collections)
- [Registered contracts](#registered-contracts)
- [Admin API: sections](#admin-api-sections)
- [Admin API: contracts and registry](#admin-api-contracts-and-registry)
- [Status and metrics](#status-and-metrics)
- [Errors](#errors)

---

## Conventions

| | |
|---|---|
| **Base URL** | `http://<proxy VIP>:30000` — production `http://192.168.68.151:30000` (the active proxy). Development: `http://localhost:30000` |
| **Body** | JSON, header `Content-Type: application/json` (limit 1 MB) |
| **Amounts** | ETH as a decimal string (`"1.5"`), never wei |
| **Addresses** | `0x…` (any letter case) |
| **Answers** | JSON. Success: `{ "success": true, … }`. Failure: an HTTP status and `{ "error": "…" }` |
| **Who may call** | the firewall's `proxy_client_ips` ([access control](../deployment/access-control.md)); the admin API also needs the admin token and an admin address |

Three kinds of callers:

| Caller | Header | Can use |
|---|---|---|
| Application **without** a section | none | the SENDER01 endpoints (unless `sections_required: true`) |
| Application **of a section** | `X-Section-Key: sk_…` | section calls: its own accounts, +x / −x transfers, NFT purchases, contract calls |
| **Operator / chainlens** | `Authorization: Bearer <ADMIN_TOKEN>`, from `ADMIN_ALLOWED_IPS` | the `/admin/*` API |

```bash
# example
curl -s -X POST http://192.168.68.151:30000/createaccount \
  -H 'Content-Type: application/json' -H 'X-Section-Key: sk_…' \
  -d '{"amount":"2","pool":"none"}'
```

---

## Accounts and transfers

### `POST /createaccount` — new account (new MPC key)

The 3 MPC nodes run distributed key generation: the private key never exists. **Needs all 3 MPC
nodes online.**

| Field | | |
|---|---|---|
| `amount` | ETH | funding of the new account |
| `pool` | optional | presignature pool class: `big`, `small` (default, `MPC_NEW_ACCOUNT_POOL`) or `none`. `big` = fast signing for busy accounts |

- **With `X-Section-Key`:** the account is registered under the section on chain and funded from
  the section's **upfront** account.
- **Without a key:** funded by `SENDER01`.

```json
→ { "success": true, "section": { "id": 1, "name": "Shop A" }, "address": "0x…",
    "from": "<upfront account>", "amount": "2", "txHash": "0x…", "registryTxHash": "0x…" }
```

### `POST /account/pool` — change an account's pool class

`{ "address": "0x…", "pool": "big" | "small" | "none" }`

### `POST /transfer` — move ETH

**Section call** (`X-Section-Key`): the sign of `amount` sets the direction.

| Body | Direction |
|---|---|
| `{ "account": "0x…", "amount": "1", "memo": "optional" }` | **+x**: the user account → the section's **consumption** account |
| `{ "account": "0x…", "amount": "-0.5" }` | **−x**: the section's **upfront** account → the user account |

`account` must be a user account of that section.

```json
→ { "success": true, "section": {…}, "direction": "account -> consumption",
    "from": "0x…", "to": "0x…", "amount": "1", "txHash": "0x…" }
```

**Without a key** (SENDER01 mode): `{ "from": "0x…", "to": "0x…", "amount": "1", "memo": "optional" }`.
A section's accounts can't be moved this way (403).

### `GET /transfer/:txHash` — status of a transfer

Status (pending, mined, failed) and the memo.

---

## Section calls (`X-Section-Key`)

The key identifies the section; the section must be **active**. Without a key, calls use SENDER01
unless `sections_required: true` (then 401). See [sections](../features/sections.md).

| Endpoint | With the section key |
|---|---|
| `POST /createaccount` | account of the section, funded from its upfront account |
| `POST /transfer` | +x / −x (above) |
| `POST /nft/transfer` | sale of a version-3 NFT to a user account of the section (below) |
| `POST /contract/send` | a contract transaction signed by a user account of the section (below) |

---

## NFT collections

Two versions exist:

| | Version 3 (with sections) | Version 2 (legacy) |
|---|---|---|
| Deployed and minted by | the **contract account center** | SENDER01 |
| First sale pays | the buyer's section's **consumption** account (checked by the contract) | SENDER01 |
| Resale pays | the seller | the seller |
| `/nft/transfer` | needs `X-Section-Key` (or the admin token, as chainlens does) | no key |

**Choosing a collection:** `collection` in the body, or `?collection=` in the query: its **name**,
**symbol** (case-insensitive) or **address**. Without it, the default (first) collection is used.
(`contract` / `?contract=` is accepted the same way.)

### `POST /nft/deploy` — new collection

`{ "name": "Dragons", "symbol": "DRG" }` — names and symbols must be unique (409 otherwise).
Collections can also be deployed from chainlens ([contract deployment](../features/contract-deployment.md)).

```json
→ { "success": true, "contract": "0x…", "default": false, … }
```

### `GET /nft/collections`

```json
→ { "success": true, "collections": [ { "contract": "0x…", "name": "Dragons", "symbol": "DRG",
      "version": 3, "minter": "<contract account center>", "default": true }, … ] }
```

`version` 3 collections are minted by the contract account center, version 2 by SENDER01.

### `POST /nft/mint` — mint for sale

Minted to the collection's minter (the center for v3, SENDER01 for v2); nothing is paid. `amount`
is the **price** in ETH, stored on chain and fixed for every later sale.

```json
{
  "collection": "DRG",
  "name": "Red dragon",
  "description": "Level 1",
  "image": "https://example.com/red.png",
  "attributes": [{ "trait_type": "level", "value": "1" }],
  "properties": { "series": "2026" },
  "amount": "3"
}
→ { "success": true, "tokenId": "1", "contract": "0x…", "owner": "<minter>", "price": "3", "txHash": "0x…" }
```

`name` and `image` are required. Token ids start at 1 in each collection.

### `POST /nft/transfer` — sale

The buyer `to` signs **one** `buy` transaction with exactly the price: the NFT and the ETH move
together or not at all.

```bash
curl -s -X POST http://192.168.68.151:30000/nft/transfer -H 'Content-Type: application/json' \
  -H 'X-Section-Key: sk_…' -d '{"collection":"DRG","to":"0xBuyer…","tokenId":"1"}'
```
```json
→ { "success": true, "section": { "id": 1, "name": "Shop A" }, "sale": "first sale",
    "price": "3", "paidTo": "<consumption account>", "txHash": "0x…", "approveTxHash": null }
```

- **Version 3:** `to` must be a user account of the key's section; a resale must stay within the
  section; the seller's approval is sent automatically when needed.
- **Version 2:** no key; `from` is optional (default: current owner).

### Reading

| Endpoint | Answer |
|---|---|
| `GET /nft/:tokenId?collection=DRG` | token, owner, tokenURI, mint transaction, metadata |
| `GET /nft/:tokenId/metadata?collection=DRG` | the metadata JSON |
| `GET /nft/owner/:address` | tokens owned, per collection (`?collection=` for one) |
| `GET /nft/contract` | the default collection |

Step by step from Remix to a sale: [NFT workflow](../features/nft-workflow.md).

---

## Registered contracts

Only contracts registered in the SectionRegistry (deployed by the contract account center), and only
functions of their ABI.

### `POST /contract/call` — read (view / pure)

```json
{ "contract": "0x…", "function": "balanceOf", "args": ["0xOwner"] }
→ { "success": true, "function": "balanceOf(address)", "outputs": [ { "name": "0", "type": "uint256", "value": "3" } ] }
```

### `POST /contract/send` — write (`X-Section-Key` required)

Signed by `from`, a user account of the caller's section. `value` in ETH, only for payable functions.

```json
{ "contract": "0x…", "function": "transfer(address,uint256)", "args": ["0xTo", "5"], "from": "0xSectionUser", "value": "0" }
→ { "success": true, "txHash": "0x…", "blockNumber": 123, "gasUsed": 51234, "events": [ { "name": "Transfer", "args": {…} } ] }
```

`function` is a name or a full signature (needed when the name is overloaded). `NftCollection.mint`
can't be called this way (only the center mints): use `/nft/mint`.

---

## Admin API: sections

`Authorization: Bearer <ADMIN_TOKEN>` (Ansible: `state/secrets/proxy_admin_token`) from
`ADMIN_ALLOWED_IPS` (operator and the chainlens host). Usually used through the chainlens
**Sections** page. Writes go to the on-chain SectionRegistry, signed by the registry admin key.

| Endpoint | Body | Does |
|---|---|---|
| `GET /admin/sections` | `?fresh=1` (skip the 10 s cache), `?archived=1` | all sections, accounts, balances, info |
| `GET /admin/sections/:id` | | one section |
| `POST /admin/sections` | `{ "name": "…", "info": {…} }` | create: 3 MPC keys (**all 3 MPC nodes** needed), registry entry. The API key `sk_…` is in this answer **only**. No funding |
| `POST /admin/sections/:id/name` | `{ "name": "Shop A" }` | rename |
| `POST /admin/sections/:id/info` | `{ "key": "contact", "value": "…" }` | set an info field (`""` removes it) |
| `POST /admin/sections/:id/key` | | new API key; the old one stops at once |
| `POST /admin/sections/:id/active` | `{ "active": false }` | disable / enable (a disabled section's calls are refused) |
| `POST /admin/sections/:id/topup` | `{ "amount": "100" }` | SENDER01 → upfront |
| `POST /admin/sections/:id/sweep` | `{ "amount": "all" }` | consumption → payment (`"all"` or ETH) |
| `POST /admin/sections/:id/payback` | `{ "amount": "all" }` | payment → SENDER01 |
| `POST /admin/sections/:id/account` | `{ "role": "payment" }` | replace a role's account with a new MPC key; the balance moves to it |
| `POST /admin/sections/:id/archive` | `{ "confirm": "<name>" }` | all money back to SENDER01, section closed for good (history stays) |
| `GET /admin/sections/:id/accounts` | | the section's user accounts |
| `POST /admin/sections/:id/accounts` | `{ "amount": "5", "pool": "small" }` | create a user account (as `/createaccount`) |
| `POST /admin/sections/:id/transfer` | `{ "account", "amount", "memo" }` | +x / −x for a user account (as `/transfer`) |

Every money movement carries a memo naming the operation.

---

## Admin API: contracts and registry

| Endpoint | Body | Does |
|---|---|---|
| `GET /admin/contracts` | | registered contracts |
| `POST /admin/contracts/check` | `{ "kind": "common" \| "nft", "name", "abi", "bytecode", "deployedBytecode", "args" }` | dry run: arguments, gas, the future address; nothing signed |
| `POST /admin/contracts/deploy` | same | deploy as the contract account center, compare the code, register with the ABI |
| `POST /admin/registry/migrate` | `{ "from": "0xOldRegistry" }` | copy sections from a version-1 registry (Ansible `08-check.yml` runs it) |

```json
→ { "success": true, "address": "0x…", "txHash": "0x…", "codeCheck": "matches the artifact", "registryTxHash": "0x…" }
```

---

## Status and metrics

| Endpoint | Answer |
|---|---|
| `GET /status/senders` | per sender: next nonce vs Besu, value in flight, nonce gaps and stalls, corrections by the background chain check |
| `GET /metrics` | Prometheus format: senders, sections, HTTP requests and latency per route, process, Redis link. Optional `METRICS_TOKEN` (Bearer). Scraped by [monitoring](../components/monitoring.md) |

---

## Errors

| Status | Typical cause |
|---|---|
| 400 | bad input: missing field, bad amount or address, function not in the ABI, "the transaction would revert: …" |
| 401 | `X-Section-Key is required`, unknown section key, wrong admin token |
| 403 | the account is not a user of that section, disabled section, admin API from a non-admin address |
| 404 | unknown collection, token, contract or section |
| 409 | collection name or symbol already used |
| 500 / 502 / 503 | the signer, Besu or the registry did not answer; see the proxy log and [troubleshooting](../operations/troubleshooting.md) |
