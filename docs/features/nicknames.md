# Nicknames

> **What:** Nickname tokens: the contract account center mints the nicknames; a section's user account buys one (or several), each once and for good, then pays more to raise its **user level**. Sales and level upgrades can be undone within the hold period. The token holds only the nickname and its level (a number); how a level looks is up to the applications.
>
> **For:** application developers, business admins.
>
> **Related:** [avatars](avatars.md) · [sections](sections.md) · [proxy API](../reference/proxy-api.md#nicknames) · [chainlens](../components/chainlens.md)

**Contents**

- [Rules](#rules)
- [How it works](#how-it-works)
- [User levels](#user-levels)
- [1. Deploy the collection](#1-deploy-the-collection)
- [2. Mint nicknames](#2-mint-nicknames)
- [3. Set the user levels](#3-set-the-user-levels)
- [4. Buy a nickname](#4-buy-a-nickname)
- [5. Raise the user level](#5-raise-the-user-level)
- [6. Undo a sale or a level upgrade](#6-undo-a-sale-or-a-level-upgrade)
- [7. Read](#7-read)
- [Money and monitoring](#money-and-monitoring)
- [Errors](#errors)
- [Files](#files)

---

Nicknames and [avatars](avatars.md) are both **items** and share the same rules
([`proxy/contracts/BoundItems.sol`](../../proxy/contracts/BoundItems.sol)): minted by the center, bought
once by a section's user account, bound to it, the price paid at once to the buyer's section, and an
undo within the hold period. A nickname has no picture: it stores the name and its **user level**,
and each application decides how to show a level (a frame, a color, a badge…). The contract is
[`proxy/contracts/NicknameCollection.sol`](../../proxy/contracts/NicknameCollection.sol) (version 6).

## Rules

| Rule | How it is kept |
|---|---|
| **Only minted names** | the center mints each nickname with its price: `mint { nickname, price }`, token ids 1, 2, 3…. A user can buy only a minted name: there is no "pick any name" and no reserved list |
| **1 to 256 characters** | the proxy counts characters after Unicode NFC normalization and trimming spaces at both ends. The contract takes 1 to 1024 bytes |
| **Not allowed:** control characters and `< > & " ' \` | the proxy and the contract (so the token's JSON stays safe) |
| **Unique, case-insensitive** | A–Z case does not count: `Alice`, `alice` and `ALICE` are one nickname (minted once; `buy { nickname: "alice" }` finds `Alice`). Other scripts (Korean, Cyrillic…) compare exactly, after NFC |
| **Price changes until sold** | `setPrice { tokenId, price }` while the center holds the nickname |
| **Bought once, by a section's user account** | `buy`: the price goes **at once** to the buyer's own section's **consumption account** (no escrow), both checked by the contract through the SectionRegistry |
| **No resale, no transfer** | bound to the buyer (ERC-5192: `locked()` is true). `transferFrom`, `safeTransferFrom`, `approve` and `setApprovalForAll` always revert |
| **Many per account** | an account may hold several nicknames (and avatars) |
| **User level only goes up** | the owner raises it with `upgradeLevel`, paying the step prices at once to its section's consumption account. It goes down only by an undo |
| **Undo within the hold period** | `undo`: the sale, within `holdSeconds` of it (default 7 days): everything paid for the nickname is refunded, the level goes to 0, the nickname goes back to the center, for sale again. `undoLevel`: the newest level upgrade, within its own hold period: the level goes back one upgrade, only that price is refunded. Both are signed by the consumption account that was paid |

## How it works

1. The center mints nicknames (chainlens **Nicknames** page, or `POST /admin/contract/send` `mint`).
2. The application calls `POST /contract/send` with the section's key: function `buy`, args
   `{ "nickname": "Alice" }` (or `{ "tokenId": "1" }`), `from` = the user account.
3. The proxy normalizes the name (NFC, trim), finds its token, checks that it is not sold, and fills
   in the **payee** (the section's consumption account) and the **value** (the nickname's price).
4. The MPC signer signs `buy(tokenId, consumption)` **as the user account**. The contract asks the
   SectionRegistry: is the buyer a user account, is the payee its own section's consumption account?
   Then the nickname moves to the buyer and the price to the consumption account, in one transaction.
5. Later, `upgradeLevel` `{ "tokenId": "1", "level": 2 }` sends the quoted price (the sum of the
   step prices) the same way; the level is raised.
6. Within the hold period the section can send `undo` or `undoLevel` `{ "tokenId": "1" }` (no `from`):
   the proxy signs as the consumption account, which pays the refund in the same transaction.

There are no nickname routes: reads and writes use the generic contract API, like any registered
contract ([proxy API, contracts](../reference/proxy-api.md#contracts)). Reads go through
`POST /contract/call`, the section's writes through [`POST /contract/send`](../reference/proxy-api.md#post-contractsend--write),
and the center's writes (mint, prices, levels) through `POST /admin/contract/send`. With `args` as an
object, the values are friendly (prices in ETH) and the answer has a friendly `result`. The old
`/nickname/*` and `/admin/nickname/*` routes answer 410 ([removed routes](../reference/proxy-api.md#removed-routes)).

- The collection is deployed by the **contract account center** and registered in the SectionRegistry
  as a common contract. The one in use is the **latest** registered version-6 collection:
  `GET /contract/list?type=nickname` marks it `current: true`. Older collections (version 4 with edge
  styles, version 5 with one nickname per account and edge levels) are ordinary contracts for the
  proxy: no friendly values, not `type: "nickname"`. Deploy a new collection and mint the names
  again; old nicknames stay in the old contract.
- `tokenURI` is JSON made on the chain (`data:application/json;base64,…`) with the name and the
  level, and **no image**:
  `{"name":"Alice","description":"Nickname","attributes":[{"trait_type":"user level","display_type":"number","value":2}]}`.
  A level change emits ERC-4906 `MetadataUpdate` for wallets and explorers.

## User levels

A level is a number. Per level the contract stores only two things:

| Field | Meaning |
|---|---|
| `price` (step price) | ETH to go from the level below to this one |
| `forSale` | `false`: nobody can upgrade to it (or past it); nicknames already at it keep it |

Level 0 always exists: every nickname starts there, its price is always 0 and it is always for sale.
Raising from level *a* to level *b* pays the step prices of levels *a+1 … b* (`quote { tokenId, level }`),
so skipping levels costs the same as climbing. Levels are never deleted (at most 32): close one for
sale instead. An undone sale puts the level back to 0.

## 1. Deploy the collection

Once, in chainlens **Nicknames** (`#/nicknames`, shown when `chainlens_sections_enabled: true`): name,
symbol and **Undo period (days)**, then **Deploy the nickname collection**. Or with the admin API and
the `nickname-collection` template (`holdDays`: default 7, decimals allowed for tests):

```bash
P=http://192.168.68.151:30000; T=$(cat ansible/state/secrets/proxy_admin_token)
curl -s -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -X POST \
  --data '{"template":"nickname-collection","name":"Nicknames","symbol":"NICK","holdDays":7}' \
  $P/admin/contract/deploy
# { "success": true, "name": "Nicknames", "kind": "common", "address": "0xNicknames", "codeCheck": "matches the artifact", … }
```

The template takes no price (each nickname gets its own at mint). A second version-6 collection is
refused (409) unless the body has `"another": true`: then the new collection is used from then on and
the old one stays readable on the chain. Applications find the collection in use with
`GET /contract/list?type=nickname` (`current: true`).

![The chainlens Nicknames page](../images/screenshots/chainlens-nicknames.png)

## 2. Mint nicknames

On the Nicknames page, **Mint nicknames**: one name per line, one price for all (change it later per
nickname with **Change a price**). Each name is minted on its own; the answer lists each name's
token id or error, and the names that failed stay in the box. With the API, the contract account
center signs (`POST /admin/contract/send`):

```bash
send() { curl -s -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -X POST --data "$1" $P/admin/contract/send; }
send '{"contract":"0xNicknames","function":"mint","args":{"nickname":" Alice ","price":"1"}}'
# { "success": true, "function": "mint(string,uint256)", …, "result": { "minted": true, "tokenId": "1", "nickname": "Alice", "level": 0, "price": "1" } }
send '{"contract":"0xNicknames","function":"mint","args":{"nickname":"ALICE","price":"1"}}'
# { "error": "the transaction would revert: this nickname is already minted" }
send '{"contract":"0xNicknames","function":"setPrice","args":{"tokenId":"1","price":"1.25"}}'
# { "success": true, …, "result": { "tokenId": "1", "price": "1.25" } }
```

## 3. Set the user levels

On the Nicknames page, **User levels**: every level has its step price, a **For sale** checkbox and
its holder count (level 0: free); the last box adds the next level with a price. With the API:

```bash
# add the next level (its step price; it is for sale)
send '{"contract":"0xNicknames","function":"addLevel","args":{"price":"0.5"}}'
# { "success": true, "function": "addLevel(uint256)", …, "result": { "level": { "level": 1, "price": "0.5", "forSale": true } } }
# change a level: only the fields given change
send '{"contract":"0xNicknames","function":"setLevel","args":{"level":3,"forSale":false}}'
# { "success": true, "function": "setLevel(uint8,uint256,bool)", …, "result": { "level": { "level": 3, "price": "2", "forSale": false } } }
```

## 4. Buy a nickname

The application calls with the section's key. `from` is a user account of that section with enough
ETH for the price (the gas is free on this chain). Leave out the payee and `value`: the proxy fills
them in.

```bash
K=sk_…   # the section's API key
call() { curl -s -X POST $P/contract/call -H 'Content-Type: application/json' -H "X-Section-Key: $K" --data "$1"; }
# the collection in use
curl -s -H "X-Section-Key: $K" "$P/contract/list?type=nickname"
# { "contracts": [ { "address": "0xNicknames", "name": "Nicknames", "type": "nickname", "current": true, … } ] }
# a name, and the levels, in one batch
call '{"calls":[{"contract":"0xNicknames","function":"tokenOf","args":{"nickname":"alice"}},{"contract":"0xNicknames","function":"levelCount"}]}'
# results: { "tokenId": "1", "minted": true, "sold": false, "owner": "<center>", "price": "1" },
#          { "count": 3, "levels": [ { "level": 0, "price": "0", "forSale": true }, { "level": 1, "price": "0.5", "forSale": true }, … ] }
curl -s -X POST $P/contract/send -H 'Content-Type: application/json' -H "X-Section-Key: $K" \
  --data '{"contract":"0xNicknames","function":"buy","args":{"nickname":"alice"},"from":"0xUser"}'
# { "success": true, "function": "buy(uint256,address)", "from": "0xUser", "value": "1.0", "txHash": "0x…",
#   "result": { "tokenId": "1", "nickname": "Alice", "level": 0, "price": "1", "buyer": "0xUser", "paid": "1",
#               "paidTo": "0xConsumption", "undoUntil": "2026-11-30T17:36:53.234Z" },
#   "events": [ { "name": "Sold", "args": { … } }, … ] }
```

A name that was never minted: 404 `nickname "nobody" is not minted`. A sold one: 409
`token 1 is already sold`. The same account can buy more nicknames: `tokensOf { account }` lists them.

## 5. Raise the user level

Only the owner, from level to a higher level, paying the quote at once to its section's consumption
account:

```bash
call '{"contract":"0xNicknames","function":"quote","args":{"tokenId":"1","level":2}}'
# { "result": { "tokenId": "1", "level": 2, "price": "1.5" }, … }
curl -s -X POST $P/contract/send -H 'Content-Type: application/json' -H "X-Section-Key: $K" \
  --data '{"contract":"0xNicknames","function":"upgradeLevel","args":{"tokenId":"1","level":2},"from":"0xUser"}'
# { "success": true, "function": "upgradeLevel(uint256,uint8,address)", "value": "1.5", …,
#   "result": { "tokenId": "1", "nickname": "Alice", "level": 2, "price": "1", "fromLevel": 0, "paid": "1.5",
#               "paidTo": "0xConsumption", "undoUntil": "2026-11-30T17:37:13.234Z" },
#   "events": [ { "name": "LevelUpgraded", … }, { "name": "MetadataUpdate", … } ] }
```

The value is the quote (the sum of the step prices); `result.price` is the nickname's price,
`result.paid` what this upgrade cost. A lower or equal level (400 `level 1: the level can only go
up`), a level that doesn't exist or is closed for sale, another account's nickname (403 `token 1 is
not owned by 0x…`) and too little ETH are refused.

## 6. Undo a sale or a level upgrade

Both with the key of the section that was paid, through `/contract/send`, **without `from`**: the proxy
signs as that section's consumption account (the account that was paid), which sends the refund in
the same transaction. In chainlens, the Nicknames list has **Undo** and **Undo level** on each
nickname while they are possible, with the deadline.

| Function | Undoes | Within | Refund | After |
|---|---|---|---|---|
| `undo { tokenId }` | the sale | the hold period of the sale | everything paid for the nickname and not undone yet: the sale + the level upgrades | level 0, the nickname back to the center, for sale again |
| `undoLevel { tokenId }` | the **newest** level upgrade not undone yet (newest first) | the hold period of **that** upgrade | only that upgrade's price | the level before that upgrade; the sale and earlier upgrades stay |

```bash
U() { curl -s -X POST $P/contract/send -H 'Content-Type: application/json' -H "X-Section-Key: $K" --data "$1"; }
# Alice: bought for 1, raised 0 → 1 (0.5), then 1 → 2 (1)
U '{"contract":"0xNicknames","function":"undoLevel","args":{"tokenId":"1"}}'
# "result": { "tokenId": "1", "undone": "level", "level": 1, "undoneLevel": 2, "refunded": "1" }
U '{"contract":"0xNicknames","function":"undoLevel","args":{"tokenId":"1"}}'
# "result": { "tokenId": "1", "undone": "level", "level": 0, "undoneLevel": 1, "refunded": "0.5" }
U '{"contract":"0xNicknames","function":"undoLevel","args":{"tokenId":"1"}}'
# 409 { "error": "token 1 has no level upgrade to undo" }
# raised again 0 → 2 (1.5), then the sale is undone: 1 + 1.5 back
U '{"contract":"0xNicknames","function":"undo","args":{"tokenId":"1"}}'
# "result": { "tokenId": "1", "undone": "sale", "buyer": "0xUser", "refunded": "2.5", "by": "0xConsumption" }
```

Refused: after the period (409 `the undo period of token 1 ended at …`, `the undo period of the
level 0 -> 1 upgrade ended at …`), a nickname not sold (409 `token 1 is not sold`), another section's
key (403 `… only its key can undo`), too little ETH on the consumption account (409 `the refund
needs X ETH but … has Y ETH`).

## 7. Read

| Function, `args` | `result` |
|---|---|
| `tokensOf { account }` | the account's nicknames: `[ { tokenId, nickname, level, price } ]` (for the center: the unsold ones) |
| `tokenOf { nickname }` | `{ tokenId, minted, sold, owner, price }`, or `{ tokenId: null, minted: false }` (any A–Z case) |
| `ownerOf { tokenId }` | `{ tokenId, owner, sold }` |
| `priceOf { tokenId }` | `{ tokenId, price }` |
| `nicknameOf { tokenId }` / `levelOf { tokenId }` | `{ tokenId, nickname }` / `{ tokenId, level }` |
| `levelCount` / `levelInfo { level }` | `{ count, levels: [ { level, price, forSale } ] }` / one level |
| `quote { tokenId, level }` | `{ tokenId, level, price }`: what raising to `level` costs now |
| `tokenURI { tokenId }` | `{ tokenId, metadata: { name, description, attributes: [ { trait_type: "user level", display_type: "number", value } ] } }` |
| `paymentsOf { tokenId }` | every payment, oldest first: `[ { kind: "sale" \| "level", fromLevel, toLevel, amount, payer, paidTo, paidAt, undoUntil, undone, undoable, current } ]` (`fromLevel`, `toLevel` only for `level`) |
| `holdSeconds`, `totalSupply` | the undo period (seconds), the number of nicknames minted |

`POST /contract/events` lists `Sold`, `Undone`, `LevelUpgraded`, `LevelUndone`, `LevelSet`,
`PriceSet` (prices in ETH).

## Money and monitoring

| Operation | From → to | Section operation (metrics) |
|---|---|---|
| buy | user account → its section's **consumption** account (the nickname's price) | `nickname_sale` |
| raise the user level | user account → its section's **consumption** account (sum of step prices) | `level_upgrade` |
| undo | consumption account → the buyer (sale + level upgrades not undone) | `nickname_undo` |
| undo a level | consumption account → the owner (that upgrade's price) | `level_undo` |

Section **income** = sales + level upgrades − undos: in chainlens section statistics (*Nickname sales*,
*Level upgrades*, *Nicknames and levels (ETH)*, *Undone, refunded (ETH)*) and in the Grafana
**Sections** dashboard (columns **Nicknames**, **Level upgrades** and **Undone** in the All-sections
table). From the consumption account the money goes on with the usual sweep and payback
([sections](sections.md)); keep enough there for the undos still possible.

## Errors

All from `POST /contract/send`, except the last rows (reads and admin writes).

| Status | Message (start) | Cause |
|---|---|---|
| 400 | `nickname: 1 to 256 characters` | empty after trimming, or too long |
| 400 | `nickname: no control characters and none of …` | a forbidden character |
| 400 | `args: no value for "…" (…); given: …` | a misnamed or missing argument, e.g. `{ "name": … }` for `buy` |
| 400 | `args: unknown name(s) …; upgradeLevel takes tokenId, level, payee` | a name the function doesn't take (e.g. an old `account`) |
| 400 | `tokenId: a token id (1, 2, …)` | no valid token id |
| 400 | `level N: …` (a contract reason) | `upgradeLevel`: the level doesn't exist, is closed for sale, or is not above the current one |
| 400 | `payee: the consumption account of section …` | a payee was given and it is another account: leave it out |
| 400 | `value: the price is X ETH …` | a value was given and it is not the price: leave it out |
| 400 | `insufficient balance: X ETH is needed` | too little ETH |
| 400 | `from: leave it out (an undo is signed by …)` | `undo` / `undoLevel` with a `from` |
| 401 | `X-Section-Key is required` | no key (and not the admin caller) |
| 403 | `… is not a user account of a section` | `from` is a role account or unknown |
| 403 | `section "…" is disabled` | the section is turned off |
| 403 | `token N is not owned by 0x…` | `upgradeLevel` on another account's (or an unsold) nickname |
| 403 | `token N was paid to section "…": only its key can undo` | an undo with another section's key |
| 404 | `nickname "…" is not minted` / `token N is not minted` | the name or token doesn't exist |
| 409 | `token N is already sold` | a second buy (no resale) |
| 409 | `token N is not sold` / `token N has no level upgrade to undo` | nothing to undo |
| 409 | `the undo period of token N ended at …` / `the undo period of the level a -> b upgrade ended at …` | too late |
| 409 | `the refund needs X ETH but … has Y ETH` | the consumption account can't pay the refund |
| 400 | `the transaction would revert: this nickname is already minted` | `mint` of a name that exists (any A–Z case) |
| 400 | `the transaction would revert: sold: the price can no longer change` | `setPrice` on a sold nickname |
| 400 | `price: ETH, e.g. "0.5"` | admin write with a bad price |
| 400 | `the transaction would revert: level 0: price 0, always for sale` | `setLevel` on level 0 with a price or `forSale: false` |
| 404 | `level: no level N (levels 0-M)` | `setLevel` on a level that doesn't exist |
| 409 | `a nickname collection exists at 0x… (send "another": true …)` | a second deploy |
| 410 | `POST /nickname/buy was removed: use POST /contract/send …` | an old `/nickname/*` or `/admin/nickname/*` route |

## Files

| File | Contents |
|---|---|
| `proxy/contracts/BoundItems.sol` | the shared item rules: mint, `setPrice`, `buy`, `undo`, `paymentsOf`, `tokensOf`, bound tokens |
| `proxy/contracts/NicknameCollection.sol` | the contract (version 6: ERC-721 + ERC-5192 + ERC-4906): `mint(nickname, price)`, names unique without A–Z case (`tokenOf`), user levels (`addLevel`, `setLevel`, `upgradeLevel`, `undoLevel`, `quote`), JSON `tokenURI` with no picture |
| `proxy/nickname-collection.json` | its compiled artifact (`node scripts/compile-contract.js contracts/NicknameCollection.sol NicknameCollection nickname-collection.json`) |
| `proxy/stress-latest.js` | friendly args and results (`FRIENDLY_KEYS`, `friendlyArgsOf`, `friendlyCall`, `friendlySend`, `paymentsInfo`, `nicknameInput`, `readLevels`), `/contract/send` (`knownSend`: payee, price and owner checks; the undo path: `undoTarget`), the `nickname-collection` template (`templateInput`: `holdDays`), the metrics (`countKnownSend`) |
| `chainlens/server.js` | the Nicknames page's API (`/api/nicknames`, `/api/nicknames/deploy`, `mint`, `price/:tokenId`, `levels`, `undo/:tokenId`, `undolevel/:tokenId`), through the proxy's admin API |
| `chainlens/public/app.js` | the Nicknames page (`showNicknames`, `levelEditor`) |
| `monitoring/grafana/tools/gen_sections_dashboard.py` | the income (in ops minus undo ops) and the columns of the Sections dashboard |
