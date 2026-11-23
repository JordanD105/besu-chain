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
- [Nicknames](#nicknames)
- [Registered contracts](#registered-contracts)
- [Admin API: sections](#admin-api-sections)
- [Admin API: nicknames](#admin-api-nicknames)
- [Admin API: contracts and registry](#admin-api-contracts-and-registry)
- [Status and metrics](#status-and-metrics)
- [Errors](#errors)

---

## Conventions

![The three kinds of proxy callers: an application without a key, an application with X-Section-Key, and the operator or chainlens with the admin token, with the checks and the endpoints each can use](../images/diagrams/api-callers.svg)

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
| `POST /contract/send` | a contract transaction signed by a user account of the section: also every nickname and version-3 NFT write (below) |

---

## NFT collections

Two versions exist:

| | Version 3 (with sections) | Version 2 (legacy) |
|---|---|---|
| Deployed and minted by | the **contract account center** | SENDER01 |
| First sale pays | the buyer's section's **consumption** account (checked by the contract) | SENDER01 |
| Resale pays | the seller | the seller |
| Sale | `POST /contract/send` `buy` from the buyer, with `X-Section-Key` (or the admin token, as chainlens does) | `POST /nft/transfer`, no key |
| Resale | the seller's `approve`, then the buyer's `buy` (both `/contract/send`); may cross sections | `POST /nft/transfer`, no key |

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

### Version 3: sale and resale with `/contract/send`

The buyer signs **one** `buy` transaction with exactly the price: the NFT and the ETH move
together or not at all. Leave out the payee and `value`: the proxy fills in the buyer's section's
consumption account and `priceOf(tokenId)`.

```bash
curl -s -X POST http://192.168.68.151:30000/contract/send -H 'Content-Type: application/json' -H "X-Section-Key: $K" \
  --data '{"contract":"0xCollection","function":"buy","args":["7"],"from":"0xBuyer"}'
```
```json
→ { "success": true, "section": { "id": 1, "name": "Shop A" }, "function": "buy(uint256,address)", "value": "3.0",
    "txHash": "0x…", "events": [ { "name": "Sold", "args": { "tokenId": "7", "seller": "<center>", "buyer": "0xBuyer", "price": "…", "paidTo": "<consumption account>" } }, … ] }
```

- **First sale** (the center holds it): the price goes to the buyer's section's consumption account.
- **Resale** (a user holds it): two calls. First the seller's section sends `approve` from the seller,
  args `[collectionAddress, tokenId]`; then the buyer's section sends `buy`. The price goes to the
  seller (the contract ignores the payee). Each section signs only for its own accounts, so seller
  and buyer may be in different sections.
- `POST /nft/transfer` on a version-3 collection answers **410** with this pointer.

### `POST /nft/transfer` — sale (version 2)

For version-2 (legacy) collections only; no key. `from` is optional (default: current owner).

```bash
curl -s -X POST http://192.168.68.151:30000/nft/transfer -H 'Content-Type: application/json' \
  -d '{"collection":"OLD","to":"0xBuyer…","tokenId":"1"}'
```

### Reading

| Endpoint | Answer |
|---|---|
| `GET /nft/:tokenId?collection=DRG` | token, owner, tokenURI, mint transaction, metadata |
| `GET /nft/:tokenId/metadata?collection=DRG` | the metadata JSON |
| `GET /nft/owner/:address` | tokens owned, per collection (`?collection=` for one) |
| `GET /nft/contract` | the default collection |

Step by step from Remix to a sale: [NFT workflow](../features/nft-workflow.md).

---

## Nicknames

Soulbound nickname tokens with an edge level ([nicknames](../features/nicknames.md)). Every call needs
`X-Section-Key` (or the admin token); `account` must be a user account of that section. Prices in ETH.
These routes only read; buying and raising the edge go through [`POST /contract/send`](#post-contractsend--write).

| Endpoint | Body / query | Answer |
|---|---|---|
| `GET /nickname/edges` | | `{ collection, nicknamePrice, edges: [ { level, name, price, enabled, style: { color, color2, width, radius, pattern } } ] }` |
| `GET /nickname/check` | `?name=Alice` | `{ nickname, characters, tokenId, available, reason }` (`reason`: `taken`, `reserved` or `null`) |
| `GET /nickname/of/:account` | | `{ nickname, tokenId, account, level, edge, image }` (`image`: SVG data URI); 404 without one |
| `GET /nickname/quote` | `?account=0x…&level=2` | `{ account, level, price }`: the sum of the step prices up to `level` |
| `POST /contract/send` `buyNickname` | `{ "contract": "<collection>", "function": "buyNickname", "args": ["Alice"], "from": "0x…" }` | event `NicknameBought` (below) |
| `POST /contract/send` `upgradeEdge` | `{ "contract": "<collection>", "function": "upgradeEdge", "args": [2], "from": "0x…" }` | event `EdgeUpgraded` (below) |

`POST /nickname/buy` and `POST /nickname/edge` were removed (410).

Names: 1–256 characters after NFC and trimming, no control characters and none of `< > & " ' \`,
unique without regard to A–Z case, one per account. The level only goes up.

---

## Registered contracts

Only contracts registered in the SectionRegistry (deployed by the contract account center), and only
functions of their ABI.

### `POST /contract/call` — read (view / pure)

```json
{ "contract": "0x…", "function": "balanceOf", "args": ["0xOwner"] }
→ { "success": true, "function": "balanceOf(address)", "outputs": [ { "name": "0", "type": "uint256", "value": "3" } ] }
```

### `POST /contract/send` — write

Signed by `from`, a user account of the caller's section. `value` in ETH, only for payable functions.

```json
{ "contract": "0x…", "function": "transfer(address,uint256)", "args": ["0xTo", "5"], "from": "0xSectionUser", "value": "0" }
→ { "success": true, "section": { "id": 1, "name": "Shop A" }, "contract": "0x…", "function": "transfer(address,uint256)",
    "from": "0xSectionUser", "value": "0.0", "txHash": "0x…", "blockNumber": 123, "gasUsed": 51234,
    "events": [ { "name": "Transfer", "args": {…} } ] }
```

`function` is a name or a full signature (needed when the name is overloaded). `NftCollection.mint`
can't be called this way (only the center mints): use `/nft/mint`.

- **Caller:** `X-Section-Key`, or the admin token from `ADMIN_ALLOWED_IPS` without a key (as chainlens
  does): the section is then the section of `from`, which must be a user account of an active section.
- **Payee:** an `address` input named `payee` is set to the sender's section's **consumption** account
  when left out (shorter `args`, `null` or `""`). Another address → 400.
- **Price:** for the functions below, a left-out `value` is filled in with the price. Another value → 400.
- **Metrics:** the section's operations are counted from the events: `NicknameBought` → `nickname_sale`,
  `EdgeUpgraded` → `edge_upgrade`, `Sold` → `nft_first_sale` (seller = the contract account center)
  or `nft_resale`.

| Contract | Function, `args` | `value` filled in | Checks before sending | Event |
|---|---|---|---|---|
| nickname collection (`collection` of `GET /nickname/edges`) | `buyNickname`, `[nickname]` | `nicknamePrice` | trimmed + NFC, 1–256 characters, no control characters or `< > & " ' \` (400); one per account, taken, reserved (409) | `NicknameBought {tokenId, buyer, nickname, price, paidTo}` |
| nickname collection | `upgradeEdge`, `[level]` | `quote(from, level)` (sum of the step prices) | level 1 or more (400); has a nickname (404); level exists, open, above the current one (400 `level N: …`) | `EdgeUpgraded {tokenId, owner, fromLevel, toLevel, price, paidTo}` |
| NFT collection, version 3 | `buy`, `[tokenId]` | `priceOf(tokenId)` | token exists (404); `from` doesn't own it already (400) | `Sold {tokenId, seller, buyer, price, paidTo}` |
| NFT collection, version 3 | `approve`, `[collection, tokenId]` from the seller | — | — | `Approval` |

| Status | Message (start) |
|---|---|
| 400 | `payee: the consumption account of section "…" (0x…); leave it out to fill it in` |
| 400 | `value: the price is X ETH (leave "value" out to pay it)` |
| 400 | `insufficient balance: X ETH is needed` |
| 400 | `the transaction would revert: …` |
| 401 | `X-Section-Key is required: …` (no key and not the admin caller) |
| 403 | `… is not a user account of a section` / `section "…" is disabled` |

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

## Admin API: nicknames

Admin token, as above. Usually used through the chainlens **Nicknames** page. Writes are signed by
the contract account center (the collection's minter).

| Endpoint | Body | Does |
|---|---|---|
| `GET /admin/nickname` | `?q=` (search) | the collection, price, edge levels with holder counts, nicknames (up to 200) |
| `POST /admin/nickname/deploy` | `{ "name", "symbol", "price": "1", "edge0": "Simple", "another": false }` | deploy and register the collection; 409 if one exists unless `another: true` |
| `PUT /admin/nickname/price` | `{ "price": "1" }` | the nickname price (new buyers) |
| `POST /admin/nickname/edges` | `{ "name", "price", "color", "color2", "width", "radius", "pattern" }` | add the next edge level |
| `PUT /admin/nickname/edges/:level` | any of the fields above, `enabled` | change a level; existing nicknames redraw. Level 0 keeps price 0 and stays enabled |
| `POST /admin/nickname/reserve` | `{ "nicknames": ["admin"], "reserved": true }` | reserve (or free) up to 100 names |

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
