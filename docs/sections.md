# Sections

A **section** is a group of applications (section_1 … section_n) with its own accounts, its own API
key and its own allowed source addresses. Money for a section's users comes from the section's own
accounts instead of SENDER01.

**Status:** steps 1 and 2 of 6 are built: the registry, the proxy admin API to create and manage
sections, and section-scoped `/createaccount` and `/transfer`. The rest (marked with their step in
the flow table) comes next.

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
        │ admin token (operator / monitoring host)                               │ X-Section-Key + source IP
        ▼                                                                        ▼
 ┌────────────────────────────────── proxy (active, VIP .151) ──────────────────────────────────┐
 │ Admin API: /admin/sections (create, key, IPs, active; later: top-up, sweep, pay back)          │
 │ App API:   /createaccount, /transfer, /contract/call, /contract/send, /nft/*                     │
 │ sender queues: SENDER01 · upfront_i · consumption_i · payment_i · contract_account_center ·      │
 │                registry admin · user accounts                                                   │
 └────────────────┬────────────────────────────────────────────────────────────┬─────────────────┘
                  │ sign (MPC, 2 of 3)                                         │ read / send
                  ▼                                                            ▼
          coordinator → MPC nodes                                   Besu ── SectionRegistry (on chain)
```

## The SectionRegistry (on chain)

[`proxy/contracts/SectionRegistry.sol`](../proxy/contracts/SectionRegistry.sol), compiled to
[`proxy/section-registry.json`](../proxy/section-registry.json) (solc 0.8.28, EVM cancun;
`proxy/scripts/compile-contract.js`). Both proxies and chainlens read it; nothing else stores
sections, so there is no database to replicate or back up (the chain is).

| Holds | Written by |
|---|---|
| sections: name, the 3 accounts, API-key **hash** (keccak256), allowed IPs, active, created | `createSection`, `setKey`, `setAllowedIps`, `setActive` |
| user accounts of each section, and every account's kind (user, upfront, consumption, payment) | `addAccount` (step 2) |
| registered contracts and their ABI (in the `ContractRegistered` event) | `registerContract` (step 4) |
| `isConsumptionAccount(address)`: the payee check of NftCollection v3 | (view) |

Only the **registry admin** (an MPC key) writes, through the proxy. The API keys themselves are never
stored, only their hash: a key is shown once, when it is created or rotated.

Deployed once by `ansible/06-proxy.yml`: it creates the admin key on coord1, deploys the contract with
`besu-production/operator/deploy-contract.js` and writes `ansible/state/registry.json`
(`address`, `admin`); the proxy gets them as `REGISTRY_CONTRACT` and `REGISTRY_ADMIN`.

## Admin API (built)

On the proxy (`http://<vip_proxy>:30000/admin/...`), with `Authorization: Bearer <token>`
(`ansible/state/secrets/proxy_admin_token`), from `operator_ip` or the monitoring host only
(chainlens calls it there). Details: [`proxy/api.txt`](../proxy/api.txt).

| Request | Does |
|---|---|
| `GET /admin/sections` | all sections with the balances of their 3 accounts |
| `GET /admin/sections/:id` | one section |
| `POST /admin/sections {name, allowedIps}` | creates the 3 MPC keys (needs **all 3 MPC nodes** online), the API key (returned **once**) and the registry entry. No funding. |
| `POST /admin/sections/:id/key` | new API key (returned once); the old one stops working |
| `POST /admin/sections/:id/ips {allowedIps}` | replaces the allowed source addresses (IPv4 addresses or networks) |
| `POST /admin/sections/:id/active {active}` | enables / disables the section |

Names are unique (case-insensitive), 1 to 64 characters.

## Application API (built): section calls

An application of section_i sends its key in the header **`X-Section-Key: sk_…`**. The proxy
accepts the call only when the key's hash belongs to a section, the **source address** is in that
section's allowed IPs, and the section is **active**.

| Request | Section call does |
|---|---|
| `POST /createaccount {amount, pool}` | new MPC account, **registered under section_i** on chain, funded **from `upfront_account_i`** |
| `POST /transfer {account, amount: "x"}` | `account` → `consumption_account_i` |
| `POST /transfer {account, amount: "-x"}` | `upfront_account_i` → `account` |

`account` must be a user account of section_i (created by that section's `/createaccount`). The
answer names the section, the direction, `from`, `to` and the transaction. `memo` works as before.

**Calls without a key** keep the SENDER01 behaviour while `sections_required: false` (settings.yml),
for applications not moved yet, with one guard: **they can't move any section's money** — a
section account (user, upfront, consumption, payment) or the registry admin as sender is refused.
With `sections_required: true` they are refused altogether (`X-Section-Key is required`).

| Error | Cause |
|---|---|
| 401 `unknown section key` | no section has this key (rotated?) |
| 403 `section "…" is not allowed from this address` | the caller's address is not in the section's allowed IPs |
| 403 `section "…" is disabled` | the section is switched off |
| 403 `0x… is not an account of section "…"` | the account belongs to another section, or isn't a user account |
| 403 `0x… belongs to section N: call with that section's X-Section-Key` | a keyless call tried to move a section's money |
| 400 `insufficient balance` | `upfront_account_i` (or the account for `+x`) can't pay: top up / wait for a pending transfer to be mined |
| 401 `X-Section-Key is required` | `sections_required: true` and no key |

## Flows

| Action | Who | Signed by / what happens | Step |
|---|---|---|---|
| **Create section** (UI) | proxy admin API | 3 MPC keys; registry entry (registry admin); API key shown once. No funding. | **1 (built)** |
| **Rotate key / IPs / enable–disable** (UI) | proxy admin API | registry admin | **1 (built)** |
| **Top up** (UI, amount) | proxy admin API | SENDER01 → `upfront_account_i`, manual only | 3 |
| **Sweep** (UI, amount or all) | proxy admin API | `consumption_account_i` → `payment_account_i` | 3 |
| **Pay back** (UI, amount or all) | proxy admin API | `payment_account_i` → SENDER01 | 3 |
| `/createaccount` (section_i) | proxy | `upfront_account_i` → new user account; registry: account → section_i | **2 (built)** |
| `/transfer +x` (section_i) | proxy | user account → `consumption_account_i` | **2 (built)** |
| `/transfer -x` (section_i) | proxy | `upfront_account_i` → user account | **2 (built)** |
| **Deploy contract** (UI) | proxy admin API → registry | `contract_account_center`; not tied to a section | 4 |
| **Deploy NFT collection** (UI) | proxy admin API → registry | `contract_account_center` (the minter); shared by all sections | 4–5 |
| `/contract/call` | proxy | none (read); any registered contract | 4 |
| `/contract/send` (section_i) | proxy | a user account of section_i; only registered contracts and their ABI functions | 4 |
| `/nft/mint` | → `/contract/send` | `contract_account_center`: `mint(tokenId, uri, price)`; price fixed for good | 5 |
| `/nft/transfer`, first sale (section_i) | → `/contract/send` | the buyer: `buy(tokenId, payee = consumption_account_i)`; NFT → buyer, price → `consumption_account_i` | 5 |
| `/nft/transfer`, resale (section_i) | → `/contract/send` | the seller approves; the buyer `buy(tokenId)` at the same mint price; NFT → buyer, price → seller | 5 |

A section call is accepted only when **both** the `X-Section-Key` hash and the source IP
match the section, and the section is active. The proxy port itself still opens only to
`proxy_client_ips`, so a section's addresses must be in that list too.

## Build steps

1. **Registry contract and proxy admin API** (create, list, key, IPs, active) — built.
2. **Section-scoped `/createaccount` and `/transfer`** (+x to consumption, -x from upfront) — built.
3. Chainlens Sections page: create, top up, sweep, pay back, keys, IPs, history.
4. `/contract/call`, `/contract/send`, and Deploy through the proxy as `contract_account_center`.
5. NftCollection v3, and `/nft/mint` / `/nft/transfer` on `/contract/send`.
6. Monitoring: upfront low-balance alert (fixed amount), Sections dashboard.
