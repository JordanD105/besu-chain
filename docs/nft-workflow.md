# NFT workflow: Remix → chainlens Deploy → mint → sell

This guide takes an NFT collection from source code to a first sale and a resale. It uses
[`proxy/contracts/NftCollection.sol`](../proxy/contracts/NftCollection.sol) (version 3; the rules
are in [sections.md](sections.md#nft-collections)).

| Step | Where | Signed by |
|---|---|---|
| 1. Compile | Remix (`http://192.168.68.139:30200`) | nothing |
| 2. Deploy | chainlens **Deploy** page | the contract account center |
| 3. Mint | `POST /nft/mint`, or **Mint** on the collection's chainlens page | the contract account center |
| 4. Buyer | `POST /createaccount` with a section's key | — |
| 5. Sell | `POST /nft/transfer` (no key), or **Sell** on the collection's chainlens page | the buyer |

The addresses below are the production ones (proxy VIP `192.168.68.151:30000`, chainlens and Remix
on h139). Run steps 2, 3 and 5 in the browser from the operator machine or a PC in
`chainlens_deploy_ips` ([`../ansible/CHAINLENS-DEPLOY.md`](../ansible/CHAINLENS-DEPLOY.md)).

## 0. Before you start

- The sections are configured (phase 06 created the SectionRegistry and the contract account center),
  and at least one **section** exists, with money on its upfront account (chainlens **Sections**
  page, or `POST /admin/sections`).
- You need the **SectionRegistry's address**, which is the constructor argument. It is shown on the chainlens
  dashboard (*Platform overview* → *Section registry*), and is in `ansible/state/registry.json`.
- You need the **admin token** for the chainlens admin pages, on the operator:

  ```bash
  cat ansible/state/secrets/chainlens_deploy_token
  ```

## 1. Compile in Remix

1. Open `http://192.168.68.139:30200`. Create `NftCollection.sol` and paste the contents of
   [`proxy/contracts/NftCollection.sol`](../proxy/contracts/NftCollection.sol).
2. **Solidity compiler:** version `0.8.28`, **Advanced → EVM version `cancun`**, optimizer on
   (200 runs). Compile.
3. **Settings → Generate contract metadata** on. Remix writes
   `contracts/artifacts/NftCollection.json` (ABI + bytecode). Right-click it → **Download**.

   (The repository already has the same compiled artifact, which you can use instead:
   `proxy/nft-collection-v3.json`.)

To try the contract first, use *Deploy & run → Remix VM (Cancun)*: it is an in-browser chain, and
nothing leaves the browser.

## 2. Deploy in chainlens

Open `http://192.168.68.139:30100/#/deploy`:

1. **Deploy token:** paste the token.
2. **Compiler artifact:** `NftCollection.json`. If the file has several contracts, choose **NftCollection**.
3. **Constructor arguments:**
   - `name_` is the collection's name (`Dragons`);
   - `symbol_` is its symbol (`DRG`);
   - `registry_` is the SectionRegistry's address.
4. **Kind:** *NFT collection*. **Name in the registry:** optional, e.g. `Dragons`.
5. **Check**, then **Deploy**. The page links to the new contract: `#/contracts/0x…`.

The contract account center is the deployer, so it is the collection's **minter**. The collection is
registered on chain (kind NFT): the proxy finds it by address, name or symbol, and it is shared by all
sections. `GET /nft/collections` lists it.

## 3. Mint

**In chainlens:** on the collection's page (`#/contracts/0x…`), open the **Mint and sell** card. Fill in a name, a price in ETH and an image URL. The description and attributes (JSON) are optional. Click **Mint**. The
result shows the new token id and links to the NFT.

**Or with curl** (`collection` = the address, the name or the symbol):

```bash
curl -s -X POST http://192.168.68.151:30000/nft/mint -H 'Content-Type: application/json' \
  -d '{"collection":"DRG","name":"Red dragon","image":"https://example.com/red.png","description":"Level 1","attributes":[{"trait_type":"level","value":"1"}],"amount":"3"}'
```

```
{ "success": true, "tokenId": "1", "contract": "0x…", "version": 3, "owner": "<center>", "price": "3", ... }
```

The center mints the NFT to itself, for sale. `amount` is the **price** (ETH). It is fixed for good,
and every sale (first sale and resales) is at this price. Minting is not tied to a section and
pays nothing.

## 4. A buyer: a section's user account

The buyer must be a **user account of a section** and must have at least the price:

```bash
curl -s -X POST http://192.168.68.151:30000/createaccount -H 'Content-Type: application/json' \
  -H 'X-Section-Key: sk_…' -d '{"amount":"5"}'
```

```
{ "success": true, "address": "0xBuyer…", ... }
```

The account is funded from that section's upfront account. To give it more ETH later, use `POST /transfer` with the section's key
([sections.md](sections.md)).

## 5. Sell

**In chainlens:** in the **Mint and sell** card, under **Sell**, enter the token id and the buyer. The buyer
field suggests the section user accounts, with their section and balance. Click **Sell**.

**Or with curl.** No section key is needed: the section is taken from the buyer's registry entry.

```bash
curl -s -X POST http://192.168.68.151:30000/nft/transfer -H 'Content-Type: application/json' \
  -d '{"collection":"DRG","to":"0xBuyer…","tokenId":"1"}'
```

```
{ "success": true, "section": {"id": 1, "name": "Shop A"}, "sale": "first sale",
  "price": "3", "paidTo": "<Shop A's consumption account>", "txHash": "0x…", ... }
```

The buyer signs one atomic `buy(tokenId, payee)` transaction. It pays exactly the price and receives
the token; if any check fails, nothing moves.

- **First sale** (the center holds the token): the price goes to the buyer's section's
  **consumption account**. The contract itself checks that `payee` is a live section's consumption
  account.
- **Resale** (a user holds it): call `/nft/transfer` again with a new buyer, who must be a user
  of the **same section** as the seller. The proxy sends the seller's approval if needed, and the price
  goes to the **seller**.

If you send `X-Section-Key`, it is optional, and the buyer must belong to that section.

## 6. Check

- **chainlens:**
  - `#/nfts/<collection>/<tokenId>` shows the owner, the metadata and the image;
  - the buyer's account page shows its section and the NFT;
  - the **Sections** page shows the consumption account's balance.
- **Proxy:** `GET /nft/1?collection=DRG` returns the token, its owner and metadata, and
  `GET /nft/owner/0xBuyer…` lists the tokens the buyer owns.
- **Grafana → Sections:** the `nft_first_sale` / `nft_resale` operations and the ETH they moved.
- **Money:** sweep the consumption account to the payment account, and pay it back to SENDER01, on
  the chainlens **Sections** page.

## Errors

| Message | Cause |
|---|---|
| `… is not a user account of a section` | `to` was not created with `/createaccount` and a section key |
| `section "…" is disabled` | the buyer's section is disabled (Sections page) |
| `wrong price` / insufficient funds | the buyer has less than the price plus gas: top it up |
| `… is not an account of section "…"` | a resale to a user of another section, or a buyer outside the `X-Section-Key`'s section |
| `no NFT collection named …` | wrong name or symbol: use the address, or `GET /nft/collections` |
| `not minter` | the collection was not deployed by the contract account center (deployed elsewhere) |
