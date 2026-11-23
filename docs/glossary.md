# Glossary

> Terms used across the documentation, in alphabetical order.

| Term | Meaning |
|---|---|
| **Admin API** | The proxy's `/admin/*` endpoints (sections, contracts). Needs the admin token and an address in `ADMIN_ALLOWED_IPS`. Used by chainlens's admin pages and by Ansible |
| **Admin token** | Secret for the admin API and chainlens admin pages; on the operator in `ansible/state/secrets/` (`proxy_admin_token`, `chainlens_deploy_token`) |
| **Ansible phases** | The numbered playbooks `00`–`14` in `ansible/` (hosts, images, MPC, coordinators, Besu, proxy, HA, check, monitoring, backups). Phase `01` copies the code to the hosts and must run first after a `git pull` |
| **Avatar** | The platform's image token (ERC-721), an **item** in an **avatar collection** (`AvatarCollection.sol` version 4): a picture with a price, minted by the contract account center, bought once by a section user account and bound to it. See [avatars](features/avatars.md) |
| **Big / small / none pool** | Presignature pool class of an MPC key: how many presignatures are kept ready. `big` for busy accounts (SENDER01, upfront), `small` for ordinary accounts, `none` for rarely used ones (signs on the slow path) |
| **Cold path** | Signing without a ready presignature: the MPC nodes compute one on demand (about 0.6 s instead of milliseconds) |
| **Consumption account** | A section's account that **receives** money: +x transfers from users, item sales and nickname level upgrades, paid at once. It signs the **undos** and pays their refunds. Swept to the payment account |
| **Contract account center** (`CONTRACT_CENTER`) | The MPC account that deploys every contract through the proxy (and mints the avatars and nicknames, sets their prices and the user levels). Contracts it deploys are registered on chain with their ABI |
| **Coordinator** (coord1, coord2) | Combines the MPC nodes' partial signatures; holds **no** key material. Ethereum signer JSON-RPC (`eth_accounts`, `eth_sendTransaction`) on port 9100 |
| **Correction** | A request the section gateway answered and queued while offline, then the chain refused after the link came back (an item sold meanwhile, a new price, an undo period over). The gateway undoes it in its ledger, reports it (`/gateway/report`) and sends it to the application's `correction_webhook`. See [section gateway](components/gateway.md#corrections) |
| **Draining** | The section gateway's mode after a cut: it sends its queue to the proxy one request at a time, in order, checking each signer's nonce so nothing is sent twice, then reconciles its ledger with the chain and goes online |
| **Floating IP / VIP** | An address that keepalived moves between h135 and h136: `.150` (Besu RPC, MPC signer) and `.151` (the proxy) |
| **Gateway** (section gateway) | An optional service per section, next to its application (`gateway/`, port 30010): the proxy's API with the section key; while the proxy can't be reached it answers from its own ledger and queues the writes (modes online, offline, draining). See [section gateway](components/gateway.md) |
| **HA pair** | h135 and h136: everything on the application path runs on both; one is active |
| **Hold period** | How long an item sale (or a nickname level upgrade) can be **undone**: `holdDays` at deploy (default 7 days), `holdSeconds` on the contract |
| **Item** | An avatar or a nickname (`BoundItems.sol`): minted by the center, bought once by a section user account, the price paid at once to its section's consumption account, never resold or transferred (ERC-5192), undoable within the hold period |
| **MPC** | Multi-party computation: the key is split into 3 **shares** on 3 MPC nodes; any 2 can sign together, none alone. The full key never exists |
| **MPC node** (mpc1–3, node 0–2) | Holds one share of every key, checks each transaction against its policy, takes part in signing and key generation. Each run by a separate team |
| **Nickname** | The platform's name token, an **item** in the nickname collection (`NicknameCollection.sol` version 6): a name minted by the center, with a **user level**; an account may hold several. See [nicknames](features/nicknames.md) |
| **Nonce** | A sender's transaction counter. The proxy tracks it in memory (Redis is only a cache) and repairs **nonce gaps** (a missing nonce blocks all later transactions) |
| **Operator** | The machine and person running Ansible (`operator_ip`); holds `ansible/state/` |
| **Payment account** | A section's account that collects swept money; paid back to SENDER01 |
| **Policy** | Each MPC node's own rules (chain id, maximum value and gas, allowed destinations); a transaction outside them is refused |
| **Presignature** | Precomputed, single-use half of a signature; makes signing fast. Pools refill in the background |
| **Proxy** | The application API (`proxy/`, port 30000). Only one runs at a time, behind VIP `.151` |
| **QBFT** | The consensus of this chain. With 4 validators, 3 must be online to make blocks |
| **Registry admin** | The MPC account allowed to write the SectionRegistry (sections, accounts, contracts) |
| **RPC node** (rpc1, rpc2) | Non-validating Besu node that serves JSON-RPC to the proxy, coordinators and chainlens |
| **Section** | A business unit with its own API key, accounts and money flow, recorded in the SectionRegistry. See [sections](features/sections.md) |
| **Section key** (`sk_…`) | A section's API key, sent as `X-Section-Key`; shown once when created or rotated |
| **SectionRegistry** | The on-chain contract recording sections, their accounts (user, upfront, consumption, payment, retired) and registered contracts |
| **SENDER01** | The platform's main funded MPC account: funds top-ups (and, without sections, new accounts and transfers) |
| **Share** | One MPC node's piece of a key. One share alone is useless; backed up hourly per node |
| **Spare account** | An account the section gateway creates in advance while online (all 3 MPC nodes needed), registered under its section; handed out by `/createaccount` while offline |
| **Stalled** (node) | A Besu node that stopped importing blocks while still reporting "in sync" |
| **Stalled** (sender) | Proxy: a sender's transactions are ready in the pool but blocks keep coming without them |
| **Undo** | `undo` / `undoLevel` through `/contract/send` with no `from`, within the hold period: the consumption account that was paid refunds the buyer (a sale: everything paid for the item, which goes back to the center for sale; a level: only the newest upgrade) |
| **Upfront account** | A section's account that **pays out**: funds new user accounts and −x transfers; topped up from SENDER01 |
| **User account** | An account created by a section (`/createaccount` with its key); belongs to that section |
| **User level** | A nickname's level (a number, formerly *edge level*): raised by its owner by paying the step prices (`upgradeLevel`); lowered only by an undo |
| **Validator** (val1–4) | Besu node that takes part in QBFT consensus; one per host .135–.138 |
| **Version-2 collection** | The image collection from before sections (minted by SENDER01): retired, the proxy no longer reads, mints or sells it. Version-3 avatar collections (with resale) are ordinary contracts to the proxy |
| **+x / −x** | Section transfers: +x = user → consumption, −x = upfront → user |
