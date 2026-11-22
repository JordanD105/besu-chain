# Nicknames

> **What:** Nickname tokens: a user account buys one nickname, then pays more to raise its **edge** (the frame drawn around it).
>
> **For:** application developers, business admins.
>
> **Related:** [sections](sections.md) · [NFT workflow](nft-workflow.md) · [proxy API](../reference/proxy-api.md#nicknames) · [chainlens](../components/chainlens.md)

**Contents**

- [Rules](#rules)
- [How it works](#how-it-works)
- [Edge levels and styles](#edge-levels-and-styles)
- [1. Deploy the collection](#1-deploy-the-collection)
- [2. Edge levels](#2-edge-levels)
- [3. Buy a nickname](#3-buy-a-nickname)
- [4. Raise the edge](#4-raise-the-edge)
- [Money and monitoring](#money-and-monitoring)
- [Errors](#errors)
- [Files](#files)

---

There are two kinds of token. The **image token** is the NFT collection of the
[NFT workflow](nft-workflow.md) (version 3): a picture, minted by the center, sold and resold.
The **nickname token** is this page: a name a user buys for themself, which can never be sold on.

![Nicknames with edge levels Simple, Silver, Gold and Diamond](../images/screenshots/nickname-examples.png)

## Rules

| Rule | How it is kept |
|---|---|
| **1 to 256 characters** | the proxy counts characters after Unicode NFC normalization and trimming spaces at both ends. The contract takes 1 to 1024 bytes |
| **Not allowed:** control characters and `< > & " ' \` | the proxy and the contract (the picture is SVG on the chain) |
| **Unique, case-insensitive** | the token id is `keccak256` of the name with A–Z lowercased, so `Alice`, `alice` and `ALICE` are one nickname. Other scripts (Korean, Cyrillic…) compare exactly, after NFC |
| **One nickname per account** | `nicknameOf(account)` on the contract; a second buy is refused |
| **Bound to its first buyer** | soulbound (ERC-5192: `locked()` is true). `transferFrom`, `safeTransferFrom`, `approve` and `setApprovalForAll` always revert |
| **Edge only goes up** | `upgradeEdge` takes a level above the current one; there is no downgrade and no expiry |
| **Bought by a section's user account** | the buyer must be a user account (registry kind 1) and the money goes to **its own section's consumption account**, both checked by the contract through the SectionRegistry |

## How it works

1. The application calls `POST /nickname/buy {account, nickname}` with the section's key.
2. The proxy normalizes the name (NFC, trim), checks 1–256 characters and that it is free.
3. The MPC signer signs `buyNickname(nickname, consumption)` **as the user account**, with the
   nickname price as value.
4. The contract asks the SectionRegistry: is the buyer a user account, is the payee its section's
   consumption account? Then it mints the token and forwards the price.
5. Later, `POST /nickname/edge {account, level}` sends `upgradeEdge(level, consumption)` with the
   quoted price; the edge is raised and the picture redrawn.

- The collection is deployed by the **contract account center** and registered in the SectionRegistry
  as a common contract. The proxy uses the **latest** registered contract that has `buyNickname`.
- The picture (`tokenURI`) is made **on the chain**: JSON and SVG, base64. It reads the edge level's
  style each time, so a style edit redraws every nickname at that level (ERC-4906 `BatchMetadataUpdate`
  is emitted for wallets and explorers).
- Long names wrap at spaces; the font gets smaller with the length (56, 36, 28 px). Wide characters
  (Korean, Chinese, Japanese, emoji) count as two half-units of width.

## Edge levels and styles

Level 0 is the default edge every nickname starts with; its price is always 0 and it can't be
turned off. Every next level has a **step price**. Raising from level *a* to level *b* pays the step
prices of levels *a+1 … b* (`quote(account, level)`), so skipping levels costs the same as climbing.

| Style field | Values |
|---|---|
| `color`, `color2` | `#rrggbb` (`color2` is used by `double`, `gradient`, `glow`) |
| `width` | 1 to 20 (pixels) |
| `radius` | 0 to 40 (corner radius) |
| `pattern` | `solid`, `double`, `dashed`, `gradient`, `glow` |

A level can be **closed for sale** (`enabled: false`): nobody can upgrade to it (or past it), and
nicknames already at it keep it.

## 1. Deploy the collection

Once, in chainlens **Nicknames** (`#/nicknames`, shown when `chainlens_sections_enabled: true`): name,
symbol, nickname price and the name of the default edge, then **Deploy**. Or with the admin API:

```bash
T=$(cat ansible/state/secrets/proxy_admin_token)
curl -s -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -X POST \
  --data '{"name":"Nicknames","symbol":"NICK","price":"1","edge0":"Simple"}' \
  http://<proxy>:30000/admin/nickname/deploy
```

A second deploy is refused (409) unless the body has `"another": true`: then the new collection is
used from then on and the old one stays readable on the chain.

![The chainlens Nicknames page: price, edge levels with a preview, reserved nicknames, the list](../images/screenshots/chainlens-nicknames.png)

## 2. Edge levels

On the Nicknames page every level has an editor with a live preview; **Add level** adds the next one.
With the API:

```bash
curl -s -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -X POST \
  --data '{"name":"Gold","price":"1","color":"#f59e0b","color2":"#fde68a","width":6,"radius":20,"pattern":"gradient"}' \
  http://<proxy>:30000/admin/nickname/edges
```

The page also changes the nickname price (new buyers only) and **reserves** names nobody can buy
(for example `admin`).

## 3. Buy a nickname

The application calls with the section's key. `account` is a user account of that section with
enough ETH for the price (the gas is free on this chain).

```bash
K=sk_…   # the section's API key
curl -s -H "X-Section-Key: $K" "http://<proxy>:30000/nickname/check?name=Alice"
# { "nickname": "Alice", "characters": 5, "available": true, "reason": null, … }
curl -s -H "X-Section-Key: $K" -H 'Content-Type: application/json' -X POST \
  --data '{"account":"0xUser","nickname":"Alice"}' http://<proxy>:30000/nickname/buy
# { "success": true, "nickname": "Alice", "level": 0, "edge": "Simple", "price": "1", "paidTo": "0xConsumption", "txHash": "0x…", "image": "data:image/svg+xml;base64,…" }
```

`GET /nickname/of/0xUser` gives an account's nickname, level and picture at any time.

## 4. Raise the edge

```bash
curl -s -H "X-Section-Key: $K" "http://<proxy>:30000/nickname/quote?account=0xUser&level=2"
# { "account": "0xUser", "level": 2, "price": "1.5" }
curl -s -H "X-Section-Key: $K" -H 'Content-Type: application/json' -X POST \
  --data '{"account":"0xUser","level":2}' http://<proxy>:30000/nickname/edge
```

The answer has the new level and picture. A lower or equal level, a level that doesn't exist or is
closed for sale, and too little ETH are refused.

## Money and monitoring

| Operation | From → to | Section operation (metrics) |
|---|---|---|
| buy | user account → its section's **consumption** account (nickname price) | `nickname_sale` |
| raise the edge | user account → its section's **consumption** account (sum of step prices) | `edge_upgrade` |

Both count as **income** of the section: in chainlens section statistics and in the Grafana
**Sections** dashboard (columns **Nicknames** and **Edge upgrades** in the All-sections table). From
the consumption account the money goes on with the usual sweep and payback ([sections](sections.md)).

## Errors

| Status | Message (start) | Cause |
|---|---|---|
| 400 | `nickname: 1 to 256 characters` | empty after trimming, or too long |
| 400 | `nickname: no control characters and none of …` | a forbidden character |
| 401 | `X-Section-Key is required` | no key |
| 403 | `… is not a user account of a section` | `account` is a role account or unknown |
| 403 | `section "…" is disabled` | the section is turned off |
| 404 | `… has no nickname: buy one first` | edge raise before a buy |
| 409 | `… already has a nickname (one per account)` | a second buy |
| 409 | `nickname "…" is taken` / `is reserved` | another account has it (any case), or it is reserved |
| 400 | `insufficient funds` / a contract reason | too little ETH; level not above the current one, missing or closed |
| 503 | `no nickname collection yet` | deploy one first |

## Files

| File | Contents |
|---|---|
| `proxy/contracts/NicknameCollection.sol` | the contract (ERC-721 + ERC-5192 + ERC-4906, on-chain SVG) |
| `proxy/nickname-collection.json` | its compiled artifact (`node scripts/compile-contract.js contracts/NicknameCollection.sol NicknameCollection nickname-collection.json`) |
| `proxy/stress-latest.js` | the `/nickname/*` and `/admin/nickname/*` routes |
| `chainlens/public/app.js` | the Nicknames page (`showNicknames`, `edgeEditor`, `edgePreview`) |
| `monitoring/grafana/tools/gen_sections_dashboard.py` | the income and the new columns of the Sections dashboard |
