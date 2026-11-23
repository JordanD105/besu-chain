# Proxy API reference

> **What:** every endpoint of the proxy (`proxy/stress-latest.js`), with request bodies and answers.
>
> **For:** application developers and operators.
>
> **Related:** [proxy component](../components/proxy.md) · [sections](../features/sections.md) ·
> [avatars](../features/avatars.md) · [nicknames](../features/nicknames.md) · [glossary](../glossary.md)

**Section gateway:** a section's application may call its [section gateway](../components/gateway.md)
(`http://<gateway host>:30010`) instead of the proxy, with the same section key and the same API. The
gateway keeps answering while the proxy can't be reached (queued writes, a `gateway` field in the answers).

**Contents**

- [Conventions](#conventions)
- [Accounts and transfers](#accounts-and-transfers)
- [Section calls (`X-Section-Key`)](#section-calls-x-section-key)
- [Contracts](#contracts)
- [Avatar collections](#avatar-collections)
- [Nicknames](#nicknames)
- [Admin API: sections](#admin-api-sections)
- [Admin API: contracts and registry](#admin-api-contracts-and-registry)
- [Removed routes](#removed-routes)
- [Status and metrics](#status-and-metrics)
- [Errors](#errors)

---

## Conventions

![The three kinds of proxy callers: an application without a key, an application with X-Section-Key, and the operator or chainlens with the admin token, with the checks and the endpoints each can use](../images/diagrams/api-callers.svg)

| | |
|---|---|
| **Base URL** | `http://<proxy VIP>:30000` — production `http://192.168.68.151:30000` (the active proxy). Development: `http://localhost:30000` |
| **Body** | JSON, header `Content-Type: application/json` (limit 1 MB) |
| **Amounts** | ETH as a decimal string (`"1.5"`), never wei. Exception: raw ABI values in a list of `args` ([below](#arguments-a-list-or-an-object)) |
| **Addresses** | `0x…` (any letter case) |
| **Answers** | JSON. Success: `{ "success": true, … }`. Failure: an HTTP status and `{ "error": "…" }` |
| **Who may call** | the firewall's `proxy_client_ips` ([access control](../deployment/access-control.md)); the admin API also needs the admin token and an admin address |
| **Memo** | every write route takes an optional `"memo"` (at most 256 bytes); every transaction gets a memo, and write answers carry `memo`, `memoType`, `memoText`, `memoParams`, `userMemo`, `memoRequest` ([memos](#memos)) |
| **Language** | `?lang=` (`en`, `ko`, `zh`) or `Accept-Language`: the language of the memo texts |

Three kinds of callers:

| Caller | Header | Can use |
|---|---|---|
| Application **without** a section | none | `/createaccount` and `/transfer` with SENDER01, and the contract reads (`/contract/call`, `/contract/events`, `/contract/list`); all refused (401) when `sections_required: true` |
| Application **of a section** | `X-Section-Key: sk_…` | section calls: its own accounts, +x / −x transfers, contract reads and writes (avatar and nickname purchases, level upgrades, undos) |
| **Operator / chainlens** | `Authorization: Bearer <ADMIN_TOKEN>`, from `ADMIN_ALLOWED_IPS` | the `/admin/*` API, and `/contract/send` without a key |

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

**Without a key:** `{ "from": "0x…", "to": "0x…", "amount": "1", "memo": "optional" }`.
A section's accounts can't be moved this way (403).

### `GET /transfer/:txHash` — status of a transfer

Status (pending, mined, failed) and the memo: `memo` (the caller's text, else the default text in
the asked language), `memoType`, `memoText`, `memoParams`, `userMemo`, `memoRequest`.

### `POST /transfer/undo` — undo a transfer

With `X-Section-Key`: `{ "txHash": "0x…", "memo": "optional" }`. Undoes a +x or −x of the section: the
full amount goes back (+x: consumption → user; −x: user → upfront), once, within `transfer_undo_days`
(7). Errors 409 (not a +x / −x of this section, already undone, too late, not enough balance), 404,
401. `GET /transfer/:txHash` of a +x / −x shows `undoneBy`. Admin: `POST /admin/sections/:id/undo`.
[Transfer undo](../features/transfer-undo.md).

---

## Section calls (`X-Section-Key`)

The key identifies the section; the section must be **active**. Without a key, calls use SENDER01
unless `sections_required: true` (then 401). See [sections](../features/sections.md).

| Endpoint | With the section key |
|---|---|
| `POST /createaccount` | account of the section, funded from its upfront account |
| `POST /transfer` | +x / −x (above) |
| `POST /contract/send` | a contract transaction signed by a user account of the section: also every item purchase and level upgrade, and the undos (signed by the section's consumption account) ([below](#contracts)) |
| `POST /contract/call`, `/contract/events`, `GET /contract/list` | reads; the key is needed only when `sections_required: true` |

---

## Contracts

One API for every contract registered in the SectionRegistry (deployed by the contract account
center), and only for the functions and events of its ABI. The platform's own contracts (the avatar
collection and the nickname collection) use the same calls, with friendly values.

| Endpoint | Does | Caller |
|---|---|---|
| `POST /contract/call` | read: a view / pure function (`eth_call`), or up to 50 at once | anyone allowed (section key when `sections_required: true`) |
| `POST /contract/send` | write: a transaction signed by a **user account of the caller's section** | `X-Section-Key`, or the admin token |
| `POST /contract/events` | the contract's events, filtered, newest first | as `/contract/call` |
| `GET /contract/list` | the registered contracts | as `/contract/call` |
| `POST /admin/contract/send` | write signed by the **contract account center** (minter and owner of the platform's contracts) | admin token ([below](#post-admincontractsend--write-as-the-contract-account-center)) |

`contract` is the contract's address. `function` is a name, or the full signature
(`transfer(address,uint256)`) when the name is overloaded.

### Arguments: a list or an object

| `args` | Means | Example |
|---|---|---|
| a **list** | the raw ABI values in order: wei, `bytes3` hex, token ids… | `"args": ["1"]` |
| an **object** | the values **by name** (the ABI's input names; a leading or trailing `_` is ignored) | `"args": { "tokenId": "1" }` |
| left out | no arguments | |

Numbers may be strings or numbers, addresses `0x…`, booleans `true` / `false`, arrays and tuples
as JSON. With an object on the **platform's contracts**, the values are **friendly**: prices in
ETH, metadata for a mint ([table below](#friendly-values-of-the-platform-contracts)).
On other contracts an object only puts the values in the ABI's order.

- A missing or misnamed value: 400 `args: no value for "level" (quote(uint256,uint8)); given: tokenId`.
- An unknown name on another contract: 400 `args: unknown name(s) x; f(uint256) takes a, b`.
- An unknown name on the platform's contracts: 400 `args: unknown name(s) name; mint takes image, price, description, attributes`.
- Nicknames are always trimmed and NFC-normalized, also in a list.

### `POST /contract/call` — read

```json
{ "contract": "0xFaces", "function": "priceOf", "args": { "tokenId": "1" } }
→ { "success": true, "contract": "0xFaces", "function": "priceOf(uint256)",
    "result": { "tokenId": "1", "price": "0.3" },
    "outputs": [ { "name": "0", "type": "uint256", "value": "300000000000000000" } ] }
```

`result` is the friendly value. `outputs` are the raw ABI values.

**Batch:** `{ "calls": [ { contract, function, args }, … ] }`, 1 to 50 reads, on any contracts.
Each one is answered or fails on its own; `success` is true only when all succeeded.

```json
{ "calls": [
    { "contract": "0xFaces", "function": "ownerOf", "args": { "tokenId": "1" } },
    { "contract": "0xFaces", "function": "ownerOf", "args": ["77"] },
    { "contract": "0xFaces", "function": "name" } ] }
→ { "success": false, "results": [
    { "success": true, "function": "ownerOf(uint256)", "result": { "tokenId": "1", "owner": "0xUser", "sold": true }, "outputs": […], … },
    { "success": false, "status": 400, "error": "call reverted: no such token" },
    { "success": true, "function": "name()", "result": "Faces", "outputs": […], … } ] }
```

### `POST /contract/send` — write

Signed by `from`, a user account of the caller's section (an undo: by the consumption account that
was paid, [below](#undo-signed-by-the-consumption-account)). Waits for the block. `value` in ETH,
only for payable functions.

```json
{ "contract": "0x…", "function": "transfer(address,uint256)", "args": ["0xTo", "5"], "from": "0xUser", "value": "0" }
→ { "success": true, "section": { "id": 1, "name": "Shop A" }, "contract": "0x…", "function": "transfer(address,uint256)",
    "from": "0xUser", "value": "0.0", "txHash": "0x…", "blockNumber": 123, "gasUsed": 51234,
    "result": null, "events": [ { "name": "Transfer", "args": {…} } ] }
```

`result` is the friendly result of the platform's contracts (a sale, a level upgrade, an undo…),
`null` on other contracts. `events` are the contract's decoded events (raw values: wei). A
transaction mined but reverted answers 400 with `success: false`.

- **Caller:** `X-Section-Key`, or the admin token from `ADMIN_ALLOWED_IPS` without a key (as chainlens
  does): the section is then the section of `from` (an undo: of the account that was paid), which must
  be an active section.
- **Payee:** an `address` input named `payee` is set to the sender's section's **consumption** account
  when left out. Another address → 400.
- **Price:** for `buy` and `upgradeLevel`, a left-out `value` is filled in with the price; for `undo`
  and `undoLevel`, with the refund. Another value → 400.
- **Metrics:** the section's operations are counted from the events: `Sold` → `avatar_sale` /
  `nickname_sale`, `Undone` → `avatar_undo` / `nickname_undo`, `LevelUpgraded` → `level_upgrade`,
  `LevelUndone` → `level_undo`.

| Contract | Function, `args` | Signed by | `value` filled in | Checks before sending | Events |
|---|---|---|---|---|---|
| avatar, nickname | `buy`, `{ tokenId }`; avatar `{ imageUrl }`, nickname `{ nickname }` | `from` (the buyer) | `priceOf(tokenId)` | minted (404 `token N is not minted`, `image … is not minted`, `nickname "…" is not minted`); not sold (409 `token N is already sold`) | `Sold {tokenId, buyer, price, paidTo}`, `Transfer`, `Locked` |
| nickname | `upgradeLevel`, `{ tokenId, level }` | `from` (the owner) | `quote(tokenId, level)` (sum of the step prices) | `from` owns it (403 `token N is not owned by …`); the level exists, is for sale, above the current one (400 `level N: …`) | `LevelUpgraded {tokenId, owner, fromLevel, toLevel, price, paidTo}`, `MetadataUpdate` |
| avatar, nickname | `undo`, `{ tokenId }`, **no `from`** | the consumption account that was paid | the refund: the sale + the level upgrades not undone | sold (409 `token N is not sold`); within the period (409 `the undo period of token N ended at …`); the key's section was paid (403); the consumption account has the refund (409) | `Undone {tokenId, buyer, refunded, by}`, `Transfer` |
| nickname | `undoLevel`, `{ tokenId }`, **no `from`** | the consumption account that was paid | the newest upgrade's price | a level upgrade to undo (409 `token N has no level upgrade to undo`); within its period (409 `the undo period of the level a -> b upgrade ended at …`); as `undo` | `LevelUndone {tokenId, owner, fromLevel, toLevel, refunded, by}`, `MetadataUpdate` |

`mint`, `setPrice`, `addLevel` and `setLevel` can't be sent this way (only the center, `not minter`):
use [`POST /admin/contract/send`](#post-admincontractsend--write-as-the-contract-account-center).
Transfers and approvals (`transferFrom`, `approve`, …) always revert: items are bound to the buyer.

#### Undo: signed by the consumption account {#undo-signed-by-the-consumption-account}

`undo` and `undoLevel` take **no `from`**. The proxy reads `paymentsOf`, finds the account that was
paid (the consumption account of the buyer's section) and signs as it; that account sends the refund
in the same transaction, and the contract pays it to the buyer.

```json
{ "contract": "0xFaces", "function": "undo", "args": { "tokenId": "1" } }
→ { "success": true, "section": { "id": 1, "name": "Shop A" }, "function": "undo(uint256)",
    "from": "0xConsumption", "value": "0.4", "txHash": "0x…",
    "result": { "tokenId": "1", "undone": "sale", "buyer": "0xUser", "refunded": "0.4", "by": "0xConsumption" }, "events": [ … ] }
```

| Refused | Status, message |
|---|---|
| not sold, or already undone | 409 `token N is not sold` |
| after the hold period of the sale / of the newest level upgrade | 409 `the undo period of token N ended at <time>` / `the undo period of the level a -> b upgrade ended at <time>` |
| no level upgrade left (`undoLevel`) | 409 `token N has no level upgrade to undo` |
| the key of another section | 403 `token N was paid to section "…": only its key can undo` |
| the consumption account has too little ETH | 409 `the refund needs X ETH but 0x… (section "…" consumption) has Y ETH` |
| a `from` other than that account | 400 `from: leave it out (an undo is signed by 0x…, the account that was paid)` |
| the account paid is no longer a section's | 409 `token N was paid to 0x…, not a section's account` |

### `POST /contract/events` — events

```json
{ "contract": "0xFaces", "event": "Transfer", "where": { "to": "0xUser" }, "current": true }
→ { "success": true, "contract": "0xFaces", "event": "Transfer(address,address,uint256)",
    "fromBlock": 37567, "toBlock": 37592, "count": 1, "complete": true,
    "events": [ { "name": "Transfer", "args": { "from": "<center>", "to": "0xUser", "tokenId": "1" },
                  "blockNumber": 37590, "txHash": "0x…", "logIndex": 0, "time": "2026-11-23T12:20:15.000Z" } ] }
```

| Field | |
|---|---|
| `event` | the event's name (or signature); a wrong one answers 400 with the list |
| `where` | `{ arg: value }`. On an **indexed** argument the chain filters; on another one, the proxy after decoding |
| `fromBlock`, `toBlock` | default: from the contract's registration to the latest block |
| `limit` | default 100, at most 1000. The newest events first |
| `current` | `true` only with event `Transfer` and `where.to`: keeps the tokens that address **still owns** (one event per token) |

`complete: false` means the limit was reached: older events exist. On the platform's contracts
`price` and `stepPrice` are in ETH (other amounts, such as `refunded`, in wei). For the items an
account holds, `tokensOf` is simpler.

### `GET /contract/list` — registered contracts

| Query | Keeps |
|---|---|
| `?type=avatar` / `nickname` / `contract` | avatar collections, nickname collections, other contracts |
| `?kind=common` / `avatar` | the registry kind |
| `?has=upgradeLevel` | contracts with this function |
| `?q=face` | name contains (any case) |
| `?functions=1` | adds each contract's `functions` (signature, mutability) and `events` |

```json
→ { "success": true, "contracts": [
    { "address": "0xFaces", "name": "Faces", "type": "avatar", "kind": "avatar", "registeredIn": 14172,
      "symbol": "FACE", "minter": "<contract account center>" },
    { "address": "0xNicknames", "name": "Nicknames", "type": "nickname", "kind": "common", "registeredIn": 35444,
      "symbol": "NICK", "minter": "<contract account center>", "current": true } ],
  "center": "<contract account center>" }
```

Oldest first. `current: true` marks the nickname collection in use (the latest registered one).
Only the current versions are items: avatar version 4 is `type: "avatar"`, nickname version 6
`type: "nickname"`. Older collections (avatar version 3, nickname versions 4 and 5) are ordinary
contracts (`type: "contract"`, no friendly values): deploy new ones. `center` is the contract account
center's address (the deployer and minter).

### Friendly values of the platform contracts

Avatar and nickname collections are **items** ([avatars](../features/avatars.md),
[nicknames](../features/nicknames.md)). `args` as an object takes only these names (another name:
400 `args: unknown name(s) …; <function> takes …`). *Center* = only with `/admin/contract/send`.

**Arguments**, both kinds:

| Function | `args` |
|---|---|
| `buy` | `{ tokenId }`, avatar `{ imageUrl }`, nickname `{ nickname }` (payee and price filled in) |
| `undo` | `{ tokenId }` (no `from`) |
| `setPrice` (center) | `{ tokenId, price }` (ETH; until the token is sold) |
| `ownerOf`, `priceOf`, `tokenURI`, `paymentsOf` | `{ tokenId }` |
| `tokensOf`, `balanceOf` | `{ account }` (or `{ owner }`) |
| `holdSeconds`, `totalSupply`, `minter`, `name`, `symbol` | none |

| Kind | Function | `args` |
|---|---|---|
| avatar | `mint` (center) | `{ image, price, description, attributes }`: `image` required, `price` in ETH (default 0). No `name`. The proxy builds the on-chain metadata URI |
| avatar | `tokenOf` | `{ imageUrl }` |
| avatar | `imageOf` | `{ tokenId }` |
| nickname | `mint` (center) | `{ nickname, price }` (trimmed, NFC, 1–256 characters) |
| nickname | `tokenOf` | `{ nickname }` (any A–Z case) |
| nickname | `nicknameOf`, `levelOf`, `undoLevel` | `{ tokenId }` |
| nickname | `upgradeLevel` | `{ tokenId, level }` |
| nickname | `quote` | `{ tokenId, level }` |
| nickname | `levelInfo` | `{ level }` |
| nickname | `addLevel` (center) | `{ price }`: the next level's step price (ETH); it is for sale |
| nickname | `setLevel` (center) | `{ level, price, forSale }`: omitted fields keep their values |

A level stores only its step price and whether it is for sale. Level 0 always has price 0 and is
always for sale.

**Results** (`result`), prices in ETH:

| Kind | Function | `result` |
|---|---|---|
| both | `priceOf` | `{ tokenId, price }` |
| both | `ownerOf` | `{ tokenId, owner, sold }` |
| both | `balanceOf` | `{ owner, tokens }` |
| both | `tokenOf` | `{ tokenId, minted, sold, owner, price }`, or `{ tokenId: null, minted: false }` |
| both | `tokensOf` | avatar `[ { tokenId, image, price } ]`, nickname `[ { tokenId, nickname, level, price } ]` |
| both | `paymentsOf` | `[ { kind: "sale" \| "level", fromLevel, toLevel, amount, payer, paidTo, paidAt, undoUntil, undone, undoable, current } ]`, oldest first (`fromLevel`, `toLevel` only for `level`; `undoable`: can be undone now; `current`: belongs to the sale in force) |
| both | `mint` | `{ minted: true, tokenId, image, price }` / `{ minted: true, tokenId, nickname, level, price }` |
| both | `setPrice` | `{ tokenId, price }` |
| both | `buy` | the item (as in `tokensOf`) + `buyer`, `paid`, `paidTo`, `undoUntil` |
| both | `undo` | `{ tokenId, undone: "sale", buyer, refunded, by }` |
| avatar | `tokenURI` | `{ tokenId, metadata: { image, description, attributes }, image }` |
| avatar | `imageOf` | `{ tokenId, image }` |
| nickname | `tokenURI` | `{ tokenId, metadata: { name, description, attributes: [ { trait_type: "user level", display_type: "number", value } ] } }` (no image) |
| nickname | `nicknameOf` / `levelOf` | `{ tokenId, nickname }` / `{ tokenId, level }` |
| nickname | `levelCount` | `{ count, levels: [ { level, price, forSale } ] }` |
| nickname | `levelInfo` | `{ level, price, forSale }` |
| nickname | `quote` | `{ tokenId, level, price }`: the sum of the step prices up to `level` |
| nickname | `upgradeLevel` | the nickname (as in `tokensOf`) + `fromLevel`, `paid`, `paidTo`, `undoUntil` |
| nickname | `undoLevel` | `{ tokenId, undone: "level", level, undoneLevel, refunded }` (`level`: the level now) |
| nickname | `addLevel`, `setLevel` | `{ level: { level, price, forSale } }` |
| any other | a read | the one value, or an object of the named values; JSON data URIs decoded |

### Errors of the contract calls

| Status | Message (start) |
|---|---|
| 400 | `contract: a contract address` |
| 404 | `0x… is not a registered contract` |
| 400 | `function "x" is not in the contract's ABI` / `several functions have this name, give the signature …` |
| 400 | `… changes state: use POST /contract/send` / `… only reads: use POST /contract/call` (also `transferFrom`, `approve` of an item: they always revert) |
| 400 | `args: no value for "…" (…); given: …` / `args: unknown name(s) …; mint takes image, price, description, attributes` / `args: a list (raw ABI values) or an object (by name)` |
| 400 | friendly values: `price: ETH, e.g. "0.5"`, `tokenId: a token id (1, 2, …)`, `nickname: 1 to 256 characters …` |
| 404 | `token N is not minted` / `image … is not minted` / `nickname "…" is not minted` / `level: no level 40 (levels 0-3)` (`setLevel`) |
| 409 | `token N is already sold` / `token N is not sold` / `token N has no level upgrade to undo` / `the undo period of … ended at …` / `the refund needs X ETH …` |
| 403 | `token N is not owned by 0x…` / `token N was paid to section "…": only its key can undo` |
| 400 | `call reverted: …` (a read) / `calls: a list of 1 to 50 reads …` |
| 400 | `event: one of …` / `where: Sold has no argument …` / `current: only with event Transfer and where.to …` |
| 400 | `payee: the consumption account of section "…" (0x…); leave it out to fill it in` |
| 400 | `value: the price is X ETH (leave "value" out to pay it)` / `… is not payable: send no value` |
| 400 | `insufficient balance: X ETH is needed` |
| 400 | `the transaction would revert: …` (refused before signing, with the contract's reason) |
| 401 | `X-Section-Key is required: …` (no key and not the admin caller) |
| 403 | `… is not a user account of a section` / `section "…" is disabled` |

---

## Avatar collections

An **avatar** is the platform's image token, an **item**
([`AvatarCollection.sol`](../../proxy/contracts/AvatarCollection.sol) version 4, on
[`BoundItems.sol`](../../proxy/contracts/BoundItems.sol)). Collections are deployed by the **contract
account center** (the minter), registered in the SectionRegistry (kind avatar) and shared by all
sections. The center mints each image once, with a price it can change until the avatar is sold. A
section's user account buys it **once**: the price goes at once to the buyer's section's consumption
account, and the avatar is bound to the buyer (no resale, no transfer). Within the hold period
(`holdDays`, default 7) the sale can be undone.

| Task | Call |
|---|---|
| list the collections | `GET /contract/list?type=avatar` |
| deploy one | `POST /admin/contract/deploy` `{ "template": "avatar-collection", "name", "symbol", "holdDays" }` |
| mint for sale | `POST /admin/contract/send` `mint` `{ image, price, description, attributes }` |
| change a price (unsold) | `POST /admin/contract/send` `setPrice` `{ tokenId, price }` |
| buy | `POST /contract/send` `buy` `{ tokenId }` or `{ imageUrl }`, `from` = the buyer |
| undo a sale | `POST /contract/send` `undo` `{ tokenId }`, no `from` ([undo](#undo-signed-by-the-consumption-account)) |
| an account's avatars | `POST /contract/call` `tokensOf` `{ account }` |
| an image's token | `POST /contract/call` `tokenOf` `{ imageUrl }` |
| a token's details | `POST /contract/call` batch: `ownerOf`, `priceOf`, `tokenURI`, `paymentsOf` |
| the sales and undos | `POST /contract/events` `Sold`, `Undone` |

```bash
P=http://192.168.68.151:30000; T=<admin token>; K=<section key>
# deploy (names and symbols unique among the avatar collections, any case; else 409)
curl -s -X POST $P/admin/contract/deploy -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"template":"avatar-collection","name":"Faces","symbol":"FACE","holdDays":7}'
# → { "success": true, "name": "Faces", "kind": "avatar", "address": "0xFaces", "codeCheck": "matches the artifact", … }

# mint (the center holds it, for sale) and change its price
curl -s -X POST $P/admin/contract/send -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"contract":"0xFaces","function":"mint","args":{"image":"https://img.example/fox.png","price":"0.3","description":"fox"}}'
# → "function": "mint(string,string,uint256)", "result": { "minted": true, "tokenId": "1", "image": "https://img.example/fox.png", "price": "0.3" }
curl -s -X POST $P/admin/contract/send -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"contract":"0xFaces","function":"setPrice","args":{"tokenId":"1","price":"0.4"}}'
# → "result": { "tokenId": "1", "price": "0.4" }

# buy by image URL (the buyer: a user account of the key's section)
curl -s -X POST $P/contract/send -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"contract":"0xFaces","function":"buy","args":{"imageUrl":"https://img.example/fox.png"},"from":"0xUser"}'
# → "value": "0.4", "result": { "tokenId": "1", "image": "https://img.example/fox.png", "price": "0.4", "buyer": "0xUser",
#     "paid": "0.4", "paidTo": "0xConsumption", "undoUntil": "2026-11-30T17:36:09.250Z" }

# what 0xUser holds, and the payments of token 1
curl -s -X POST $P/contract/call -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"calls":[{"contract":"0xFaces","function":"tokensOf","args":{"account":"0xUser"}},{"contract":"0xFaces","function":"paymentsOf","args":{"tokenId":"1"}}]}'
# → results: [ { "tokenId": "1", "image": "https://img.example/fox.png", "price": "0.4" } ],
#            [ { "kind": "sale", "amount": "0.4", "payer": "0xUser", "paidTo": "0xConsumption", "paidAt": "…",
#                "undoUntil": "2026-11-30T17:36:09.000Z", "undone": false, "undoable": true, "current": true } ]

# undo within the hold period: 0.4 back from 0xConsumption to 0xUser, token 1 for sale again
curl -s -X POST $P/contract/send -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"contract":"0xFaces","function":"undo","args":{"tokenId":"1"}}'
# → "from": "0xConsumption", "value": "0.4", "result": { "tokenId": "1", "undone": "sale", "buyer": "0xUser", "refunded": "0.4", "by": "0xConsumption" }
```

Token ids are 1, 2, 3… in each collection. The metadata (`image`, `description`, `attributes`; no
name) is stored on chain in the token URI (JSON; one that doesn't fit in a block: 400 `metadata is
too large for the chain`). Each image can be minted once (`this image is already minted`). Step by
step: [avatars](../features/avatars.md).

**Older collections:** version 3 (with resale) is an ordinary contract to the proxy; version 2
(minted by SENDER01) is **retired**: the proxy no longer reads, mints or sells it. Both stay on the chain.

### Old names

The proxy still accepts the names used before the rename to *avatar*:

| Old name | Now |
|---|---|
| `?type=nft`, `?kind=nft` | `?type=avatar`, `?kind=avatar` |
| `"kind": "nft"` (deploy, check) | `"kind": "avatar"` (on chain the kind is still number 2) |
| template `nft-collection` | template `avatar-collection` |

Answers always use the new names. These functions of older collections are gone, with no alias:

| Gone | Now |
|---|---|
| avatar `approve` (put up for resale), resale through `buy` | nothing: an avatar is bought once and bound to the buyer |
| avatar `mint` `{ name, image, properties, … }` | `mint` `{ image, price, description, attributes }` (no name) |
| nickname `buyNickname` `{ nickname }` | `buy` `{ nickname }` or `{ tokenId }` (only minted names) |
| nickname `upgradeEdge` `{ level }`, `quote` `{ account, level }` | `upgradeLevel` `{ tokenId, level }`, `quote` `{ tokenId, level }` |
| nickname `addEdge`, `setEdge`, `edgeCount`, `edgeInfo`, `edgeOf` | `addLevel`, `setLevel`, `levelCount`, `levelInfo`, `levelOf` |
| nickname `setNicknamePrice`, `nicknamePrice` | `setPrice` `{ tokenId, price }`, `priceOf` (each nickname has its own price) |
| nickname `reserve`, `reserved`, `isAvailable`, `idOf` | nothing (only names the center mints can be bought); `tokenOf` `{ nickname }` |
| nickname `nicknameOf` `{ account }` | `tokensOf` `{ account }` (an account may hold many); `nicknameOf` `{ tokenId }` |
| template `nickname-collection` `price` | `mint` `{ nickname, price }` |

The metrics `op` values changed too: `nft_first_sale` → `avatar_sale`; `nft_resale` and
`avatar_resale` are gone; `edge_upgrade` → `level_upgrade`; new: `avatar_undo`, `nickname_undo`,
`level_undo`. The dashboards keep showing the old names' history.

---

## Nicknames

Nickname tokens with a **user level** ([nicknames](../features/nicknames.md)), in the **nickname
collection** (version 6, an **item** like the avatars): a registered contract deployed by the center.
Find it with `GET /contract/list?type=nickname` (the one with `current: true`). The center mints the
names; a section's user account buys one or several, each once; the owner raises the level. Prices in ETH.

| Task | Call | `result` |
|---|---|---|
| mint (center) | `POST /admin/contract/send` `mint` `{ nickname, price }` | `{ minted, tokenId, nickname, level, price }` |
| change a price (center, unsold) | `POST /admin/contract/send` `setPrice` `{ tokenId, price }` | `{ tokenId, price }` |
| add / change a level (center) | `POST /admin/contract/send` `addLevel` `{ price }` / `setLevel` `{ level, price, forSale }` | `{ level: { level, price, forSale } }` |
| user levels | `POST /contract/call` `levelCount` | `{ count, levels: [ { level, price, forSale } ] }` |
| find a name | `POST /contract/call` `tokenOf` `{ nickname }` | `{ tokenId, minted, sold, owner, price }` |
| an account's nicknames | `POST /contract/call` `tokensOf` `{ account }` | `[ { tokenId, nickname, level, price } ]` |
| price of a level | `POST /contract/call` `quote` `{ tokenId, level }` | `{ tokenId, level, price }` |
| buy | `POST /contract/send` `buy` `{ nickname }` or `{ tokenId }`, `from` | the nickname + `buyer`, `paid`, `paidTo`, `undoUntil` |
| raise the user level | `POST /contract/send` `upgradeLevel` `{ tokenId, level }`, `from` = the owner | the nickname + `fromLevel`, `paid`, `paidTo`, `undoUntil` |
| undo the sale | `POST /contract/send` `undo` `{ tokenId }`, no `from` | `{ tokenId, undone: "sale", buyer, refunded, by }` |
| undo the newest level upgrade | `POST /contract/send` `undoLevel` `{ tokenId }`, no `from` | `{ tokenId, undone: "level", level, undoneLevel, refunded }` |
| payments | `POST /contract/call` `paymentsOf` `{ tokenId }` | the sale and level upgrades, with `undoUntil`, `undoable` |

```bash
curl -s -X POST $P/contract/call -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"calls":[{"contract":"0xNicknames","function":"tokenOf","args":{"nickname":"  alice "}},{"contract":"0xNicknames","function":"levelCount"}]}'
# → results: { "tokenId": "1", "minted": true, "sold": false, "owner": "<center>", "price": "1" },
#            { "count": 3, "levels": [ { "level": 0, "price": "0", "forSale": true }, { "level": 1, "price": "0.5", "forSale": true }, … ] }
curl -s -X POST $P/contract/send -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"contract":"0xNicknames","function":"buy","args":{"nickname":"alice"},"from":"0xUser"}'
# → "value": "1.0", "result": { "tokenId": "1", "nickname": "Alice", "level": 0, "price": "1", "buyer": "0xUser", "paid": "1",
#     "paidTo": "0xConsumption", "undoUntil": "…" }
curl -s -X POST $P/contract/send -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"contract":"0xNicknames","function":"upgradeLevel","args":{"tokenId":"1","level":2},"from":"0xUser"}'
# → "value": "1.5", "result": { "tokenId": "1", "nickname": "Alice", "level": 2, "price": "1", "fromLevel": 0, "paid": "1.5", … }
curl -s -X POST $P/contract/send -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"contract":"0xNicknames","function":"undoLevel","args":{"tokenId":"1"}}'
# → "from": "0xConsumption", "value": "1.5", "result": { "tokenId": "1", "undone": "level", "level": 0, "undoneLevel": 2, "refunded": "1.5" }
```

Names: 1–256 characters after NFC and trimming, no control characters and none of `< > & " ' \`,
unique without regard to A–Z case, only minted names can be bought, many per account. The level
only goes up, except by an undo: `undo` refunds the sale and the level upgrades not undone and puts
the level to 0; `undoLevel` undoes the newest upgrade only, within its own hold period, and refunds
only its price.

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

Every transaction carries a memo naming the operation (`section.topup`, `section.sweep`, …), plus the
`memo` of the request when given ([memos](#memos)).

---

## Admin API: contracts and registry

Admin token, as above.

| Endpoint | Body | Does |
|---|---|---|
| `POST /admin/contract/check` | a template, or `{ "kind": "common" \| "avatar", "name", "abi", "bytecode", "deployedBytecode", "immutableReferences", "args" }` | dry run: arguments, gas, the future address; nothing signed |
| `POST /admin/contract/deploy` | same | deploy as the contract account center, compare the code, register with the ABI |
| `POST /admin/contract/send` | `{ "contract", "function", "args", "value" }` | a write signed by the contract account center ([below](#post-admincontractsend--write-as-the-contract-account-center)) |
| `POST /admin/registry/migrate` | `{ "from": "0xOldRegistry" }` | copy sections from a version-1 registry (Ansible `08-check.yml` runs it) |

```json
→ { "success": true, "name": "Faces", "kind": "avatar", "address": "0x…", "deployer": "<center>", "txHash": "0x…",
    "blockNumber": 37570, "gasUsed": 1408380, "codeCheck": "matches the artifact", "registryTxHash": "0x…" }
```

### Templates

The platform's own contracts are compiled into the proxy image. `check` and `deploy` take a
template instead of `abi` and `bytecode`; the registry's address is filled in.

| Template | Body | Registered as |
|---|---|---|
| `avatar-collection` | `{ "template": "avatar-collection", "name": "Faces", "symbol": "FACE", "holdDays": 7 }` (`name` and `symbol` required). Names and symbols are unique among the avatar collections, any case: else 409 | kind avatar |
| `nickname-collection` | `{ "template": "nickname-collection", "name": "Nicknames", "symbol": "NICK", "holdDays": 7, "another": false }` (these values are the defaults). No price: each nickname gets its own at mint | common |

`holdDays` is the undo period of a sale (and of a nickname level upgrade): default 7, 0 to 365,
decimals allowed (`0.0025` = 216 s, for tests); else 400 `holdDays: 0 to 365 (default 7)`. It is
fixed at deploy (`holdSeconds` on the contract).

A second version-6 nickname collection is refused (409 `a nickname collection exists at 0x… (send "another": true …)`)
unless `"another": true`: the new one is used from then on. An unknown template: 400
`template: avatar-collection or nickname-collection (or no template: abi and bytecode)`.

### `POST /admin/contract/send` — write as the contract account center

Same body as `/contract/send`, without `from`: the contract account center signs (the minter and
owner of the platform's contracts). Any registered contract; friendly `args` and `result` as in
[the table](#friendly-values-of-the-platform-contracts).

| Function | `args` |
|---|---|
| `mint` (avatar) | `{ "image", "price": "0.5", "description", "attributes" }` (the metadata URI is built here) |
| `mint` (nickname) | `{ "nickname", "price": "1" }` |
| `setPrice` | `{ "tokenId", "price" }`: until the token is sold |
| `addLevel` | `{ "price": "1" }`: the next user level's step price; it is for sale |
| `setLevel` | `{ "level": 3, "price": "2", "forSale": false }`: omitted fields keep their values. Level 0 keeps price 0 and stays for sale |

```json
{ "contract": "0xNicknames", "function": "setLevel", "args": { "level": 3, "forSale": false } }
→ { "success": true, "function": "setLevel(uint8,uint256,bool)", "from": "<center>",
    "txHash": "0x…", "result": { "level": { "level": 3, "price": "2", "forSale": false } },
    "events": [ { "name": "LevelSet", "args": { "level": "3", "stepPrice": "2000000000000000000", "forSale": false } } ] }
```

The center does not buy, upgrade or undo: those go through [`/contract/send`](#post-contractsend--write).

A revert answers 400 (`the transaction would revert: …` before signing, `reverted in block N` after).

---

## Removed routes

These routes answer **410**; the message names the call that replaces each. `0xFaces` and
`0xNicknames` are the contract addresses from `GET /contract/list`.

| Removed | Use |
|---|---|
| `POST /nft/deploy` | `POST /admin/contract/deploy` `{ "template": "avatar-collection", "name", "symbol" }` |
| `POST /nft/mint` | `POST /admin/contract/send` `mint` `{ image, price }` |
| `POST /nft/transfer` | `POST /contract/send` `buy` `{ tokenId }`, `from` = the buyer (avatars are bought once, never resold). Version-2 collections are retired |
| `GET /nft/contract`, `GET /nft/collections` | `GET /contract/list?type=avatar` |
| `GET /nft/owner/:address` | `POST /contract/call` `tokensOf` `{ account }` |
| `GET /nft/:tokenId/metadata` | `POST /contract/call` `tokenURI` `{ tokenId }` (`result.metadata`) |
| `GET /nft/:tokenId` | `POST /contract/call` batch `ownerOf`, `priceOf`, `tokenURI`, `paymentsOf` |
| `GET /nickname/edges` | `POST /contract/call` `levelCount` (`result.levels`); the collection: `GET /contract/list?type=nickname` |
| `GET /nickname/check` | `POST /contract/call` `tokenOf` `{ nickname }` |
| `GET /nickname/of/:account` | `POST /contract/call` `tokensOf` `{ account }` |
| `GET /nickname/quote` | `POST /contract/call` `quote` `{ tokenId, level }` |
| `POST /nickname/buy` | `POST /contract/send` `buy` `{ nickname }`, `from` |
| `POST /nickname/edge` | `POST /contract/send` `upgradeLevel` `{ tokenId, level }`, `from` |
| `POST /admin/nickname/deploy` | `POST /admin/contract/deploy` `{ "template": "nickname-collection", "name", "symbol" }` |
| `PUT /admin/nickname/price` | `POST /admin/contract/send` `setPrice` `{ tokenId, price }` (each nickname has its own price) |
| `POST /admin/nickname/edges` | `POST /admin/contract/send` `addLevel` `{ price }` |
| `PUT /admin/nickname/edges/:level` | `POST /admin/contract/send` `setLevel` `{ level, price, forSale }` |
| `POST /admin/nickname/reserve` | nothing: reserved names are gone (only names the center mints can be bought) |
| `GET /admin/contracts` | `GET /contract/list` (`center`: the contract account center) |
| `POST /admin/contracts/check` | `POST /admin/contract/check` (same body) |
| `POST /admin/contracts/deploy` | `POST /admin/contract/deploy` (same body) |
| `GET /admin/nickname` | `GET /contract/list?type=nickname` (the collection), `POST /contract/call` (`levelCount`, `totalSupply`, `tokensOf`) and `POST /contract/events` (`Sold`, `Undone`, `LevelUpgraded`, `LevelUndone`) |

```json
GET /nft/collections
→ 410 { "error": "GET /nft/collections was removed: use GET /contract/list?type=avatar" }
```


---

## Memos

Every transaction the proxy sends carries a memo record at the end of its data: the memo type, the
section, the values, the caller's `memo` and a request id. Readers show it in English, Korean or
Chinese. The whole design: [memos](../features/memos.md).

| | |
|---|---|
| **Parameter** | `"memo": "order 1234"` on any write route (`/transfer`, `/createaccount`, `/contract/send`, `/admin/…`); a string of at most 256 UTF-8 bytes, else 400 |
| **Answer fields** | `memo` (what to show), `memoType`, `memoText` (the default text), `memoParams`, `userMemo`, `memoRequest` |
| **Language** | `?lang=ko` (or `en`, `zh`), else `Accept-Language`, else `memo_default_lang` |
| **Read back** | `GET /transfer/:txHash`; chainlens (every transaction, the Memos page, `GET /api/memos`) |

```json
POST /contract/send?lang=ko   { "contract": "0xAvatars", "function": "buy", "args": { "imageUrl": "https://…/fox.png" }, "from": "0xUser", "memo": "gift for mom" }
→ { "success": true, …, "memo": "gift for mom", "memoType": "avatar.buy",
    "memoText": "Shop B: 아바타 #1 0.12 ETH에 구매", "memoParams": { "tokenId": "1", "imageUrl": "https://…/fox.png", "amount": "0.12" },
    "userMemo": "gift for mom", "memoRequest": "47181dc1" }
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
| 400 | bad input: missing field, bad amount or address, function not in the ABI, a missing `args` value, "the transaction would revert: …" |
| 401 | `X-Section-Key is required`, unknown section key, wrong admin token |
| 403 | the account is not a user of that section, disabled section, not the token's owner, an undo with another section's key, admin API from a non-admin address |
| 404 | unknown contract, token, image, nickname, user level or section |
| 409 | collection name or symbol already used; a token already sold, or not sold (undo); an undo period over; the consumption account can't pay a refund; a nickname collection exists |
| 410 | a removed route ([above](#removed-routes)) |
| 500 / 502 / 503 / 504 | the signer, Besu or the registry did not answer, or a transaction was not mined in time; see the proxy log and [troubleshooting](../operations/troubleshooting.md) |
