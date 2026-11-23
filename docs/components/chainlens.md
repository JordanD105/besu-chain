# Chainlens (block explorer)

> **What:** the web explorer of the chain (`chainlens/`): blocks, transactions, accounts, contracts,
> NFTs, the platform overview and section statistics, plus admin pages for deploying contracts,
> managing sections, and minting, selling and undoing avatars and nicknames.
>
> **For:** everyone who looks at the chain; the admin pages are for operators.
>
> **Related:** [sections](../features/sections.md) · [contract deployment](../features/contract-deployment.md) ·
> [avatars](../features/avatars.md) · [access control](../deployment/access-control.md) · [section gateway](gateway.md)

**Contents**

- [At a glance](#at-a-glance)
- [Pages](#pages)
- [Admin pages](#admin-pages)
- [How it works](#how-it-works)
- [Settings](#settings)
- [Run and update](#run-and-update)

---

## At a glance

| | |
|---|---|
| **URL** | `http://192.168.68.139:30100` (production, h139); `http://localhost:30100` (development) |
| **Who can open it** | `chainlens_ips` in `settings.yml` (plus the operator); see [access control](../deployment/access-control.md) |
| **Reads** | rpc2 directly (`BESU_RPC`), the SectionRegistry's events, the contract records in `contracts/deployments/` |
| **Writes** | nothing by itself; the admin pages forward to the proxy's admin API |
| **Languages / themes** | English and Chinese (EN / 中文 switch), dark and light |

![Chainlens dashboard: totals, platform overview and section balances](../images/screenshots/chainlens-dashboard.png)

## Pages

| Page | URL | Shows |
|---|---|---|
| **Dashboard** | `#/` | totals (transactions, tokens, contracts, peers); **Platform overview**: SENDER01, the contract account center, the section registry, section counts, each section's balances (upfront / consumption / payment / users, stacked) and user accounts; **Section statistics** per day, week, month, quarter or year, or a date range (stacked closing balances, new users, income, avatar sales, nickname sales, level upgrades, nicknames and levels (ETH), undone / refunded (ETH), top-ups, sweeps…); the transaction chart; most active contracts; token types |
| **Accounts** | `#/accounts` | every account with balance and transaction count; the **Section** column (section and role: user, upfront, consumption, payment, retired; system accounts SENDER01, contract center, registry admin) and a section filter. An account's page shows its section, transactions and tokens |
| **NFTs** | `#/nfts` | NFTs (ERC-721 tokens) of every collection, avatars and nicknames, with image, owner and price; an NFT's page shows its metadata and history |
| **Contracts** | `#/contracts` | contracts seen on chain; registered ones (deployed through the proxy or recorded in `contracts/deployments/`) have a page with their functions: **view / pure functions run in the page** (read only). Avatar collections get the **Mint and sell avatars** card (admin) |
| **Transactions** / **Blocks** | `#/transactions`, `#/blocks` | lists and detail pages (decoded function calls, events, the memo of every transaction in the page's language) |
| **Memos** | `#/memos` | the [memo](../features/memos.md) of every transaction: filters (type, section, text, dates, request id), export CSV / JSON (`GET /api/memos`) |
| **Network** | `#/network` | the node chainlens reads: peers, versions |
| **API** | `#/api` | chainlens's own JSON API (`/api/...`) |

Everything except the admin pages is visible to everyone who can open chainlens: the information is
public on chain anyway.

![Chainlens Accounts page with the Section column](../images/screenshots/chainlens-accounts.png)

![Section statistics on the dashboard, per period](../images/screenshots/chainlens-statistics.png)

![A registered contract page with its read-only functions](../images/screenshots/chainlens-contract.png)

## Admin pages

Hidden until enabled, and usable only from `operator_ip` and `chainlens_deploy_ips`, with the
admin token (`cat ansible/state/secrets/chainlens_deploy_token`; kept for the browser tab only).
They forward to the proxy's admin API, so the proxy signs, never chainlens: **Deploy** and the
nickname collection's deploy call `/admin/contract/deploy`; **Mint**, **Change a price** and the user
levels call `/admin/contract/send` (signed by the contract account center); **Sell an avatar** calls
`/contract/send` (signed by the buyer); **Undo** and **Undo level** call `/contract/send` without `from`
(signed by the consumption account that was paid, which refunds the buyer); the lists read
`/contract/list` and `/contract/call` (`totalSupply`, `ownerOf`, `priceOf`, `paymentsOf`…).

| Page / card | Enabled by | Does | Guide |
|---|---|---|---|
| **Deploy** (`#/deploy`) | `chainlens_deploy_enabled: true` | deploy a compiled contract (Remix / Hardhat / Foundry artifact) as the contract account center, check first, register it | [contract deployment](../features/contract-deployment.md) |
| **Sections** (`#/sections`) | `chainlens_sections_enabled: true` | create sections, top up, sweep, pay back, rename, info fields, keys, replace accounts, archive; a section's user accounts | [sections](../features/sections.md) |
| **Nicknames** (`#/nicknames`) | `chainlens_sections_enabled: true` | deploy the nickname collection (name, symbol, undo period in days); **Mint nicknames** (one per line, one price); **Change a price**; **User levels** (step price, for sale, holders; add a level); the list of nicknames (token id, nickname, price, account or *for sale*, user level) with **Undo** / **Undo level** while possible | [nicknames](../features/nicknames.md) |
| **Mint and sell avatars** (on an avatar collection's page) | either of the above | **Mint an avatar** (image, price, description, attributes); **Change a price** (until sold); **Sell an avatar** (token id or image URL, buyer: a section's user account); the list of avatars (newest first) with **Undo** while possible | [avatars](../features/avatars.md) |

**Section gateway notice:** with section gateways (`gateway_enabled`), the **Sections** page asks each
gateway for its status (`GET /api/sections/gateways`, which calls `/gateway/status` on every gateway in
`GATEWAYS`, 3 s timeout) and shows a red notice at the top for each section whose gateway is not
online: *its gateway cannot reach the proxy (offline since …, N queued) … make no admin writes on this
section (transfers, top-ups, sweeps, account changes) until it is back*, or *its gateway does not
answer*. See [the single-writer rule](gateway.md#the-single-writer-rule).

**Gateway card:** on a section's page, when the section has a gateway, a **Gateway** card shows its
mode, queue, spare accounts, cuts, corrections and last snapshot, the list of
[corrections](gateway.md#corrections) with an **Acknowledge** button, and the reconcile reports
(`GET /api/sections/:id/gateway`, `POST /api/sections/:id/gateway/ack/:report`, through the
gateways' report token `GATEWAY_REPORT_TOKEN`, which can only read and acknowledge). The Sections list
shows a notice per section with open corrections.

![The admin Sections page: the list of sections and the New section form](../images/screenshots/chainlens-sections.png)

![The admin Deploy page](../images/screenshots/chainlens-deploy.png)

## How it works

- **Indexing:** polls the RPC node every 4 s, indexes blocks, transactions, accounts and NFTs in
  memory; re-indexes from scratch after a chain reset. Balances are refreshed in the background.
- **Registry:** reads the SectionRegistry's events every 15 s from its deployment block, in
  1,000-block chunks: sections, section accounts and roles, registered contracts with their ABI.
- **Overview and statistics:** `/api/overview` (balances read every 15 s) and
  `/api/sections/stats` (computed from the indexed transactions, cached 15 s). Past balances are
  rebuilt backwards from today's (gas is free on this chain).

## Settings

Written by Ansible (`ansible/templates/chainlens.env.j2`) into `chainlens/.env` on h139:

| Variable | Meaning |
|---|---|
| `BESU_RPC` | the RPC node chainlens reads (rpc2) |
| `PORT` | 30100 |
| `REGISTRY_CONTRACT`, `REGISTRY_FROM_BLOCK` | the SectionRegistry and its deployment block |
| `CONTRACT_CENTER` | the contract account center (marked in Accounts and the overview) |
| `ADMIN_TOKEN`, `ADMIN_ALLOWED_IPS` | the admin pages' token and allowed addresses |
| `PROXY_ADMIN_URL`, `PROXY_ADMIN_TOKEN` | where the admin pages forward (the proxy VIP) |
| `DEPLOY_ENABLED`, `SECTIONS_ENABLED` | turn the admin pages on |
| `GATEWAYS` | the section gateways, `<section id>=http://<gateway host>:30010 …` (the Sections page notice, the Gateway card) |
| `GATEWAY_REPORT_TOKEN` | reads the gateways' corrections and acknowledges them (`state/secrets/gateway_report_token`) |

In `settings.yml`: `chainlens_ips`, `chainlens_deploy_enabled`, `chainlens_sections_enabled`,
`chainlens_deploy_ips`.

## Run and update

```bash
# production (from ansible/, after a git pull): copy the code, build the image, deploy
ansible-playbook 01-hosts.yml 02-images.yml 11-chainlens.yml
```

```bash
# development
cd chainlens && cp .env.example .env && docker compose up -d --build
```
