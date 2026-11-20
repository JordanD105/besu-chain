# Sections

A **section** is a group of applications (section_1 … section_n) with its own accounts and its own
API key. Money for a section's users comes from the section's own accounts instead of SENDER01.

**Status:** all 6 steps are built: the registry (version 2), the proxy admin API, section-scoped
`/createaccount` and `/transfer`, the chainlens **Sections** page (with the sections' user
accounts), contracts deployed by the contract account center with `/contract/call` and
`/contract/send`, NFT collections version 3 (minted by the center, sales paid to the section), and
monitoring (alerts and the Grafana **Sections** dashboard).

## Accounts

| Account | How many | Role | Presignature pool |
|---|---|---|---|
| SENDER01 | 1 | Funds the upfront accounts (manual top-up); receives money back from payment accounts | big |
| `upfront_account_i` | 1 per section | **Pays out:** funds new accounts, `/transfer -x` | big |
| `consumption_account_i` | 1 per section | **Receives:** `/transfer +x`, first NFT sales; swept to `payment_account_i` | none |
| `payment_account_i` | 1 per section | **Collects** the swept money; can pay it back to SENDER01 | none |
| `contract_account_center` | 1 | Deploys all contracts (common and NFT), mints all NFTs | big |
| registry admin | 1 | The only writer of the SectionRegistry | small |
| user accounts | many | Created by `/createaccount`, belong to one section | as requested |

Every account is an MPC key. **Only the proxy sends transactions** from them (one queue per account,
ordered nonces); chainlens is the UI and calls the proxy's admin API.

## Architecture

```
  chainlens UI: Sections · Deploy · Contracts · NFTs                       apps of section_i
        │ admin token (operator_ip / chainlens_deploy_ips)                       │ X-Section-Key
        ▼                                                                        ▼
 ┌────────────────────────────────── proxy (active, VIP .151) ──────────────────────────────────┐
 │ Admin API: /admin/sections (create, rename, info, key, active, top-up, sweep, pay back,         │
 │            replace account, archive)                                                           │
 │ App API:   /createaccount, /transfer, /contract/call, /contract/send, /nft/*                     │
 │ sender queues: SENDER01 · upfront_i · consumption_i · payment_i · contract_account_center ·      │
 │                registry admin · user accounts                                                   │
 └────────────────┬────────────────────────────────────────────────────────────┬─────────────────┘
                  │ sign (MPC, 2 of 3)                                         │ read / send
                  ▼                                                            ▼
          coordinator → MPC nodes                                   Besu ── SectionRegistry (on chain)
```

## The SectionRegistry (on chain, version 2)

[`proxy/contracts/SectionRegistry.sol`](../proxy/contracts/SectionRegistry.sol), compiled to
[`proxy/section-registry.json`](../proxy/section-registry.json) (solc 0.8.28, EVM cancun;
`proxy/scripts/compile-contract.js`). Both proxies and chainlens read it; nothing else stores
sections, so there is no database to replicate or back up (the chain is), every change is a signed
transaction, and contracts can check it (NftCollection v3, step 5).

| Holds | Changed by |
|---|---|
| name (unique, 1–64 characters) | `createSection`, `setName` |
| the 3 accounts | `createSection`, `replaceAccount` (the old account stays the section's, *retired*) |
| API-key **hash** (keccak256; the key itself is never stored) | `createSection`, `setKey` |
| active / archived | `setActive`, `archive` |
| info fields: any key (1–32 characters) → value (up to 512 bytes), up to 32 per section | `setInfo` (an empty value removes the field) |
| user accounts of each section, every account's kind | `addAccount`, `addAccounts` |
| registered contracts and their ABI (in the `ContractRegistered` event) | `registerContract` (step 4) |
| `isConsumptionAccount(address)`: the payee check of NftCollection v3 | (view) |

Only the **registry admin** (an MPC key) writes, through the proxy. New kinds of section
information go into **info fields** (description, contact, limits, …) without a new contract.

Deployed by `ansible/06-proxy.yml`: it creates the admin key on coord1, deploys the contract with
`besu-production/operator/deploy-contract.js` and writes `ansible/state/registry.json`
(`address`, `admin`); the proxy gets them as `REGISTRY_CONTRACT` and `REGISTRY_ADMIN`.
**Upgrade from version 1:** `06-proxy.yml` sees the older version and deploys version 2 (same
admin, `previous` recorded in `registry.json`); `08-check.yml` then migrates the sections (name,
accounts, key hash, active) and their user accounts, once (`migrated: true`). Section keys keep
working. Version 1's allowed IPs are dropped (sections are identified by their key alone).

## Admin API

On the proxy (`http://<vip_proxy>:30000/admin/...`), with `Authorization: Bearer <token>`
(`ansible/state/secrets/proxy_admin_token`), from `operator_ip` or the monitoring host only
(chainlens calls it there). Details: [`proxy/api.txt`](../proxy/api.txt).

| Request | Does |
|---|---|
| `GET /admin/sections` (`?archived=1`) | sections with the balances of their 3 accounts (archived ones only on request) |
| `GET /admin/sections/:id` | one section |
| `POST /admin/sections {name, info}` | creates the 3 MPC keys (needs **all 3 MPC nodes** online), the API key (returned **once**), the registry entry, optional info fields. No funding. |
| `POST /admin/sections/:id/name {name}` | renames |
| `POST /admin/sections/:id/info {key, value}` | sets an info field; `value: ""` removes it |
| `POST /admin/sections/:id/key` | new API key (returned once); the old one stops working |
| `POST /admin/sections/:id/active {active}` | enables / disables |
| `POST /admin/sections/:id/topup {amount}` | SENDER01 → `upfront_account_i` |
| `POST /admin/sections/:id/sweep {amount \| "all"}` | `consumption_account_i` → `payment_account_i` |
| `POST /admin/sections/:id/payback {amount \| "all"}` | `payment_account_i` → SENDER01 |
| `POST /admin/sections/:id/account {role}` | a new MPC key for `upfront`, `consumption` or `payment`; the old account's whole balance moves to it |
| `GET /admin/sections/:id/accounts` | the section's user accounts with their balances |
| `POST /admin/sections/:id/accounts {amount, pool}` | a new user account of the section, funded from its upfront account |
| `POST /admin/sections/:id/transfer {account, amount}` | `+x` account → consumption, `−x` upfront → account |
| `POST /admin/sections/:id/archive {confirm: "<name>"}` | all money of the 3 accounts back to SENDER01, then closed for good: key stops working, name freed, history stays |

Every money move carries a memo (`section 1 top-up`, `section 1 sweep`, …), so the chain itself
says what it was.

## Chainlens Sections page

**Blockchain → Sections** (`http://<monitoring host>:30100/#/sections`), when
`chainlens_sections_enabled: true`. Same access as the Deploy page: `operator_ip` and
`chainlens_deploy_ips`, with the same token (`state/secrets/chainlens_deploy_token`); for every other
address the page and its menu entry don't exist. Chainlens forwards each action to the proxy's admin
API (the proxy's token never reaches the browser) and logs it with the requester's address.

- **List:** each section with its status, the 3 balances and its info fields; **New section** (name,
  optional description) shows the API key once, with a copy button.
- **A section's page:** its accounts and balances; its **user accounts** (list with balances,
  **Create account** funded from the upfront account, **Transfer** `+amount` account → consumption /
  `−amount` upfront → account); **Top up**, **Sweep**, **Pay back** (amount, or
  `all` for sweep and pay back); **Rename**; **info fields** (add, edit, remove); **New API key**;
  **Enable / Disable**; **New upfront / consumption / payment account**; **Archive** (type the
  name to confirm); and its **history**: every transaction of its 3 accounts, labelled (top-up,
  upfront → account, account → consumption, sweep, pay back).

## Contracts (step 4)

Every contract is deployed by **`contract_account_center`** (an MPC key, big pool, created once by
`ansible/06-proxy.yml`: `state/contract-center`), through the proxy, then **registered in the
SectionRegistry** with its kind (common / NFT collection), its name and its ABI. Chainlens and the
proxy read the registered contracts from the chain (`ContractRegistered` events), so a deployed
contract is usable and visible at once, on every host, with nothing to copy.

**Deploy** — chainlens **Deploy** page (`chainlens_deploy_enabled`, same access as before), or the
proxy admin API:

| Request | Does |
|---|---|
| `GET /admin/contracts` | the center's address and the registered contracts |
| `POST /admin/contracts/check {kind, name, abi, bytecode, deployedBytecode, immutableReferences, args}` | dry run: arguments, gas, no revert; the address it will get |
| `POST /admin/contracts/deploy {…same}` | deploys (signed by the center), checks the code on chain against `deployedBytecode`, registers it |

The contract's `msg.sender` at construction is the center: a contract with an owner or roles should
take them as constructor arguments when the center must not hold them.

**Use** — applications, through the proxy:

| Request | Does |
|---|---|
| `POST /contract/call {contract, function, args}` | runs a **view/pure** function (`eth_call`), returns the decoded outputs. No key needed while `sections_required: false`. |
| `POST /contract/send {contract, function, args, from, value}` + `X-Section-Key` | sends a **state-changing** function, signed by `from`, a **user account of the caller's section**; waits for the block; returns the status and the contract's decoded events. `value` (ETH) only for payable functions. |

Only **registered** contracts, only functions of **their ABI**. `function` is a name, or the
signature (`transfer(address,uint256)`) when the name is overloaded. Arguments: numbers as strings
or numbers, addresses `0x…`, booleans `true`/`false`, arrays and tuples as JSON (or JSON text). A
transaction that would revert is refused before it is signed, with the reason (`the transaction
would revert: …`).

## NFT collections (step 5)

New collections are **NftCollection version 3** ([`proxy/contracts/NftCollection.sol`](../proxy/contracts/NftCollection.sol),
`proxy/nft-collection-v3.json`): deployed and minted by the **contract account center**, registered
in the SectionRegistry, shared by all sections.

| Request | What happens |
|---|---|
| `POST /nft/deploy {name, symbol}` | the center deploys a version-3 collection (its minter, with the registry's address) and registers it (kind NFT) |
| `POST /nft/mint {collection, name, image, …, amount}` | the center mints the NFT to itself, for sale; `amount` is its **price**, fixed for good. Not tied to a section. |
| `POST /nft/transfer {collection, to, tokenId}` + `X-Section-Key` | a sale to `to`, a **user account of the caller's section**, who signs `buy(tokenId, payee)` paying the mint price. **First sale** (the center holds it): the price goes to the section's **consumption account**. **Resale** (a user holds it, of the same section): the seller's approval is sent if needed and the price goes to the **seller**. |

The contract itself enforces where a first sale's money goes: `buy` checks
`SectionRegistry.isConsumptionAccount(payee)` (a live section's consumption account), so even a
transaction sent around the proxy can't redirect it. A version-3 sale without a section key is
refused. **Version-2 collections** (minted by SENDER01, e.g. those made before) keep working as
before, without a key.

## Sections in the chainlens Accounts page

Visible to every chainlens user (the information is public on chain): the **Accounts** list has a
**Section** column (the section's name and the account's role: `user`, `upfront`, `consumption`,
`payment`, `retired`; system accounts are marked `SENDER01`, `contract center`, `registry admin`)
and a filter (one section, no section, system accounts); an account's page shows its section, role
and what the role does. Chainlens reads the section events of the SectionRegistry (new accounts,
renames, replaced accounts, archives) every 15 s.

## Platform overview on the chainlens Dashboard

Visible to everyone, under the Dashboard's totals: four cards (**SENDER01** with its balance, the
**contract center** with the contracts it deployed, common and NFT, the **section registry** with its
contract and admin, and the **sections**: active, disabled, archived, user accounts), then a
**Sections** card with each section's balances (upfront / consumption / payment, stacked) and its
number of user accounts, with a hover tooltip per section and a **Table** view. Read from the chain
every 15 s (`GET /api/overview`).

## Application API: section calls

An application of section_i sends its key in the header **`X-Section-Key: sk_…`**. The proxy
accepts the call when the key's hash belongs to a section that is **active** (not disabled or
archived). Who may reach the proxy at all is the firewall's `proxy_client_ips`.

| Request | Section call does |
|---|---|
| `POST /createaccount {amount, pool}` | new MPC account, **registered under section_i** on chain, funded **from `upfront_account_i`** |
| `POST /transfer {account, amount: "x"}` | `account` → `consumption_account_i` |
| `POST /transfer {account, amount: "-x"}` | `upfront_account_i` → `account` |

`account` must be a user account of section_i (created by that section's `/createaccount`). The
answer names the section, the direction, `from`, `to` and the transaction. `memo` works as before.

**Calls without a key** keep the SENDER01 behaviour while `sections_required: false` (settings.yml),
for applications not moved yet, with one guard: **they can't move any section's money** — a
section account (user, upfront, consumption, payment, retired) or the registry admin as sender is
refused. With `sections_required: true` they are refused altogether (`X-Section-Key is required`).

| Error | Cause |
|---|---|
| 401 `unknown section key` | no live section has this key (rotated? archived?) |
| 403 `section "…" is disabled` | the section is switched off |
| 403 `0x… is not an account of section "…"` | the account belongs to another section, or isn't a user account |
| 403 `0x… belongs to section N: call with that section's X-Section-Key` | a keyless call tried to move a section's money |
| 400 `insufficient balance` | `upfront_account_i` (or the account for `+x`) can't pay: top up / wait for a pending transfer to be mined |
| 401 `X-Section-Key is required` | `sections_required: true` and no key |

## Flows

| Action | Who | Signed by / what happens | Step |
|---|---|---|---|
| **Create section** (UI) | proxy admin API | 3 MPC keys; registry entry (registry admin); API key shown once. No funding. | **built** |
| **Rename / info / key / enable–disable** (UI) | proxy admin API | registry admin | **built** |
| **Top up** (UI, amount) | proxy admin API | SENDER01 → `upfront_account_i`, manual only | **built** |
| **Sweep** (UI, amount or all) | proxy admin API | `consumption_account_i` → `payment_account_i` | **built** |
| **Pay back** (UI, amount or all) | proxy admin API | `payment_account_i` → SENDER01 | **built** |
| **Replace an account** (UI) | proxy admin API | new MPC key; registry admin; old account → new account (whole balance) | **built** |
| **Archive** (UI) | proxy admin API | the 3 accounts → SENDER01 (all), then registry admin | **built** |
| `/createaccount` (section_i) | proxy | `upfront_account_i` → new user account; registry: account → section_i | **built** |
| `/transfer +x` (section_i) | proxy | user account → `consumption_account_i` | **built** |
| `/transfer -x` (section_i) | proxy | `upfront_account_i` → user account | **built** |
| **Deploy contract** (UI) | proxy admin API → registry | `contract_account_center`; not tied to a section | **built** |
| **Deploy NFT collection** (UI) | proxy admin API → registry | `contract_account_center` (the minter); shared by all sections (NftCollection v3 in step 5) | **built** (v3: 5) |
| `/contract/call` | proxy | none (read); any registered contract | **built** |
| `/contract/send` (section_i) | proxy | a user account of section_i; only registered contracts and their ABI functions | **built** |
| `/nft/mint` | proxy (center's queue) | `contract_account_center`: `mint(tokenId, uri, price)`; price fixed for good | **built** |
| `/nft/transfer`, first sale (section_i) | proxy (buyer's queue) | the buyer: `buy(tokenId, payee = consumption_account_i)`; NFT → buyer, price → `consumption_account_i` | **built** |
| `/nft/transfer`, resale (section_i) | proxy | the seller approves; the buyer `buy(tokenId, …)` at the same mint price; NFT → buyer, price → seller | **built** |

## Monitoring (step 6)

The proxy's `/metrics` (scraped by Prometheus through the proxy VIP) adds:

| Metric | |
|---|---|
| `proxy_section_balance_eth{section_id, section, role, active}` | each account's balance (role upfront / consumption / payment), refreshed every 15 s |
| `proxy_section_active{section_id, section}` | 1 = enabled |
| `proxy_section_operations_total`, `proxy_section_amount_eth_total` `{section_id, section, op}` | operations and ETH moved since the proxy started (op: `create_account`, `transfer_in`, `transfer_out`, `nft_first_sale`, `nft_resale`, `topup`, `sweep`, `payback`, `account_replaced`, `archive_return`); they restart at 0 with the proxy (dashboards use `increase()`) |
| `proxy_sender01_balance_eth` | SENDER01's balance |
| `proxy_section_low_balance_eth`, `proxy_sender01_low_balance_eth` | the alert thresholds |

Settings (`ansible/group_vars/all/settings.yml`): **`upfront_low_balance_eth`** (default 100; 0 =
off) and **`sender01_low_balance_eth`** (default 10000). Alerts `SectionUpfrontLow` (warning),
`SectionUpfrontEmpty` (critical), `Sender01Low`, `SectionMetricsFailing`
([`../monitoring/prometheus/rules/sections.yml`](../monitoring/prometheus/rules/sections.yml)); the
**Sections** dashboard in Grafana shows balances, the threshold line and the activity per section.
Disabled and archived sections don't raise the upfront alerts.

## Build steps

1. **Registry contract and proxy admin API** — built (version 2: rename, info fields, account
   replacement, archive; no per-section IPs).
2. **Section-scoped `/createaccount` and `/transfer`** (+x to consumption, -x from upfront) — built.
3. **Chainlens Sections page**: create, top up, sweep, pay back, rename, info, keys, accounts,
   archive, history — built.
4. **`/contract/call`, `/contract/send`, and Deploy through the proxy as `contract_account_center`** — built.
5. **NftCollection v3**, `/nft/mint` by the center, `/nft/transfer` by section buyers — built; and the
   sections' user accounts in chainlens.
6. **Monitoring**: upfront low-balance alert (fixed amount), SENDER01 alert, Sections dashboard — built.
