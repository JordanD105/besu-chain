# besu-chain

A private Hyperledger Besu (QBFT) blockchain with:

- **`proxy/`**: an application API for accounts, ETH transfers and NFT collections;
- **`mpc-signer/`**: **non-exportable transaction signing**, a 2-of-3 MPC signer where the private
  key never exists anywhere. It replaces Vault + Web3Signer.
- **`chainlens/`**: a block explorer, plus monitoring.

The same components run in two setups:

| | Development / test | Production |
|---|---|---|
| Where | everything on one Docker host | separate hosts, sites and admin teams |
| Besu | [`besu-test-network/`](besu-test-network) | [`besu-production/`](besu-production) |
| MPC signer | [`mpc-signer/quickstart/`](mpc-signer/quickstart) (3 nodes on one host) | [`mpc-signer/deploy/`](mpc-signer/deploy) (one node per host and team) |
| Proxy, explorer | `proxy/`, `chainlens/` with Docker Compose | same images, private network, behind an API gateway |
| Guide | [Development](#development--test-environment) | [Production](#production) |

**Contents**
- [Components](#components)
- [What happens on a request](#what-happens-on-a-request)
- [Production](#production): architecture, deployment order, failure tolerance, remaining gaps
- [Development / test environment](#development--test-environment)
- [Proxy API](#proxy-api)
- [Documentation index](#documentation-index)

---

## Components

| Folder | What it is | Ports |
|---|---|---|
| [`besu-production/`](besu-production) | **Production Besu**: per-host packages for validators and RPC nodes. Keys are generated on each host; network files are checksummed; static peers + node allowlist; validators added or removed by vote. | 30303 p2p, 8545 RPC nodes, 9545 metrics |
| [`besu-test-network/`](besu-test-network) | **Development Besu**: 4 validators + `rpcnode` on one host, chain id 1337, 1 s blocks, zero gas price. Prometheus, Grafana, Loki + Alloy, Tempo. (Its bundled Chainlens services are not used.) | 8545 / 8546 rpcnode, 21001–21004, 9090, 3000, 3100 |
| [`mpc-signer/`](mpc-signer) | **2-of-3 threshold ECDSA signer** (CGGMP24 / LFDT Lockness), Web3Signer-compatible JSON-RPC. Quick start, production packages, benchmark. | 9100 coordinator, 7000 nodes |
| [`proxy/`](proxy) | **Application API** (Node.js/Express): accounts, transfers, NFT collections. Redis is an optional cache: correctness comes from memory + the chain. | 30000 API, 36379 Redis |
| [`chainlens/`](chainlens) | **Block explorer** (Node.js/Express): blocks, transactions, accounts, contracts, NFTs. NFT sales show the image. Polls RPC every 4 s, indexes in memory, re-indexes after a chain reset. | 30100 |
| [`besu-vault-web3signer/`](besu-vault-web3signer) | **Previous signer, being retired**: Vault KV keeps exportable private keys and Web3Signer loads them into memory. Kept for comparison benchmarks. | 8200 Vault, 9000 Web3Signer |

## What happens on a request

**`POST /transfer`** (ETH from an account):
1. The proxy takes the sender's lock and computes the nonce as max(cached counter, chain pending count), so a lost or stale Redis is harmless.
2. It checks the balance, including value still pending.
3. It calls `eth_sendTransaction` on the MPC coordinator.
4. **2 of the 3 MPC nodes** each check the transaction against their own policy (chain id, value and gas limits, allowlist) and produce a partial signature from a single-use presignature. The coordinator combines them into a normal ECDSA signature.
5. The signed transaction goes to a Besu RPC node, and the QBFT validators include it in the next block.

**`POST /createaccount`**: the 3 MPC nodes run **distributed key generation**. The new account's private key never exists. `SENDER01` then funds it.

**NFTs** (collections are `NftCollection` version 2, deployed by `SENDER01`):
- **`POST /nft/mint`** mints to `SENDER01` and stores the **price** on chain. Nothing is paid.
- **`POST /nft/transfer`** is a sale. The buyer signs **one atomic `buy` transaction**: they pay exactly the price to `SENDER01` and receive the NFT, or nothing happens at all.
- Collections can be chosen by name, symbol or address.

---

## Production

![besu-chain production architecture](docs/architecture-production.png)

<sub>Source: [`docs/architecture-production.svg`](docs/architecture-production.svg)</sub>

### Network zones

| Zone | Contents | Reachable from |
|---|---|---|
| **Public edge** | L7 load balancer / API gateway (HA pair, bring your own, e.g. nginx, HAProxy, Kong): TLS, client authentication, rate limits, WAF | internet: the **only** public entry |
| **App zone** | `proxy` (1 active + standby), Redis (single instance, a cache), `chainlens` | the gateway |
| **Signing zone** | `mpc-coordinator` × 1–2 (no key material); `mpc-node` 0/1/2 on **3 sites, run by 3 different admin teams** | proxy → coordinator → nodes, nodes → coordinator relay; each team's bastion |
| **Chain zone** | 4 QBFT validators, one per failure domain (p2p only); RPC nodes × 2+ for apps; 1 read-only RPC node for the explorer | apps → RPC nodes only; validators: p2p + the operator over SSH |
| **Ops** | Prometheus + Alertmanager, Grafana, logs; per-team secret stores and backups; bastion + MFA | scrapes metrics; cannot call signing APIs |

All hosts communicate over a **private encrypted network** (WireGuard or a site-to-site VPN),
with default-deny firewalls. Each package includes `firewall-example.sh` with the exact ports.

### Deployment order

The MPC signer comes first: its first key, `SENDER01`, is funded in the Besu genesis block.

| # | Step | Guide | Result |
|---|---|---|---|
| 1 | **MPC signer: nodes + key ceremony.** 3 node hosts (one team each), coordinator(s), `cluster.json` with the signing policy, aux info + key generation. | [`mpc-signer/docs/production.md`](mpc-signer/docs/production.md), steps 1–8 | `SENDER01` address; no private key exists |
| 2 | **Besu network.** Each validator and RPC host runs `init.sh`; the operator runs `make-network.sh` with `ALLOC="<SENDER01>=<wei>"`; each host runs `start.sh` (verifies `SHA256SUMS`). | [`besu-production/README.md`](besu-production/README.md) | running chain; `SENDER01` funded |
| 3 | **Connect the signer to Besu.** On the coordinator(s), set `MPC_BESU_RPC` = an app RPC node and `MPC_POOL_KEYS=<SENDER01>`, then `docker compose up -d`. | [`mpc-signer/docs/production.md`](mpc-signer/docs/production.md), steps 8–10 | hot-key presignature pool filling |
| 4 | **Proxy + Redis.** In `proxy/.env` set: `BESU_IP` / `BESU_PORT` = app RPC node; `WEB3SIGNER_IP` / `WEB3SIGNER_PORT` = coordinator:9100; `SENDER01`; `MPC_ADMIN_URL` / `MPC_ADMIN_TOKEN`; `REDIS_*`; **no** `VAULT_*` and no `NFT_CONTRACT`. Then `docker compose up -d --build`. | [`docs/proxy-with-mpc-signer.md`](docs/proxy-with-mpc-signer.md) | API on :30000 (private) |
| 5 | **NFT collections.** `POST /nft/deploy` for each collection (unique name and symbol). | [`proxy/api.txt`](proxy/api.txt) | version-2 collections, minter = `SENDER01` |
| 6 | **Explorer.** `chainlens/.env`: `BESU_RPC` = the read-only explorer RPC node; then `docker compose up -d --build`. | [`chainlens/`](chainlens) | explorer on :30100 (private) |
| 7 | **API gateway** in front of the proxy and chainlens (TLS, auth, rate limits). | your gateway | the only public entry |
| 8 | **Monitoring and backups.** Prometheus targets (`besu-production/monitoring/prometheus.yml`), alerts, per-team MPC share backups (`deploy/node/backup.sh`), validator key backups (`backup-key.sh`), restore drill. | both production guides | |

### What keeps running when something fails

| Failure | Effect |
|---|---|
| 1 MPC node, site or admin team | none: the other 2 of 3 sign. `/createaccount` waits for all 3 (key generation). |
| theft of 1 MPC node, disk or backup | the attacker gets one share: **no key, cannot sign** |
| 1 validator (of 4) | none: quorum is 3. Grow to 7 validators to tolerate 2. |
| 1 coordinator or app RPC node (with 2 deployed) | none, behind the internal load balancer |
| Redis down, empty or restored from an old snapshot | none for correctness: the proxy uses memory + the chain (nonces, prices, collections, metadata) |
| proxy process | requests fail until the standby takes over (one active replica today, see below) |
| sustained load beyond the presignature rate | signing slows to the cold path (~0.6 s per signature). Size MPC node CPU at ~0.4 cores per sustained TPS ([`mpc-signer/bench/RESULTS.md`](mpc-signer/bench/RESULTS.md)). |

### Remaining gaps before full production

- **Proxy:** the per-sender lock is in process memory, so run **one active replica** (with a
  standby) until it moves to Redis.
- **MPC signer:**
  - no mTLS on the node API and no authentication on the relay; mitigated by the private
    network and firewall;
  - no key refresh: if a share is lost for good, create new keys and move funds;
  - EIP-1559 transactions not supported;
  - `cggmp24 0.7.0-alpha.3` is an alpha release, and its audit covers an earlier version.
- **Besu:** no TLS on JSON-RPC (private network or an internal TLS proxy); the node allowlist is
  a file, so changing it means restarting the nodes.
- **Gateway and centralized monitoring** are not included in this repository; bring your own.

---

## Development / test environment

Everything on one host with Docker Compose. All ports are open, keys are test keys, and both
signers are available side by side. **Do not use it for production.**

![besu-chain development / test environment](docs/architecture-dev.png)

<sub>Source: [`docs/architecture-dev.svg`](docs/architecture-dev.svg)</sub>

```bash
# 1. Besu test network + monitoring (chain id 1337, rpcnode on :8545, Grafana on :3000)
cd besu-test-network && ./run.sh

# 2. MPC signer: 3 nodes + coordinator on this host (prints SENDER01 after setup)
cd mpc-signer/quickstart
MPC_BIGINT=bigint-rug CHAIN_ID=1337 ./quickstart.sh init
./quickstart.sh up && ./quickstart.sh setup
#    then in quickstart/.env: MPC_POOL_KEYS=<SENDER01>  and  ./quickstart.sh up

# 3. Fund SENDER01: add it to besu-test-network/config/besu/genesis.json "alloc" before step 1
#    (or transfer from a funded test account)

# 4. Proxy + Redis (proxy/.env: BESU_IP/PORT, WEB3SIGNER_IP/PORT=<coordinator>:9100, SENDER01,
#    MPC_ADMIN_URL, MPC_ADMIN_TOKEN, REDIS_*)
cd proxy && docker compose up -d --build

# 5. Explorer on http://localhost:30100 (chainlens/.env: BESU_RPC)
cd chainlens && cp .env.example .env && docker compose up -d --build
```

The full walkthrough, including troubleshooting (policy limit, nonce gaps, stale NFT contract
after a chain reset) is [`docs/proxy-with-mpc-signer.md`](docs/proxy-with-mpc-signer.md).

**Benchmark** the MPC signer against Vault + Web3Signer:

```bash
cd mpc-signer && bench/run-bench.sh                     # its own Besu + Vault + Web3Signer
cd mpc-signer && OLD_STACK=existing bench/run-bench.sh  # your running stack
```

Results are in [`mpc-signer/bench/RESULTS.md`](mpc-signer/bench/RESULTS.md).

---

## Proxy API

| Endpoint | Body / query | What it does |
|---|---|---|
| `POST /createaccount` | `{amount}` | new account = new MPC key, funded with `amount` ETH from `SENDER01` |
| `POST /transfer` | `{from, to, amount, memo?}` | ETH transfer signed by the MPC signer |
| `GET /transfer/:txHash` | | transaction status and memo |
| `POST /nft/deploy` | `{name, symbol}` | deploys a **new** collection (names and symbols must be unique) |
| `GET /nft/collections` | | all collections (address, name, symbol, default) |
| `POST /nft/mint` | `{collection?, name, image, description?, attributes?, properties?, amount}` | mints to `SENDER01`; `amount` = the price, stored on chain |
| `POST /nft/transfer` | `{collection?, to, tokenId, from?}` | sale: the buyer signs one atomic `buy` (pays the price to `SENDER01`, receives the NFT) |
| `GET /nft/:tokenId`, `/nft/:tokenId/metadata` | `?collection=` | token, owner, metadata (read from the chain if Redis has nothing) |
| `GET /nft/owner/:address` | `?collection=` | tokens owned, per collection |

`collection` accepts a collection's name, symbol or address; without it the default (first)
collection is used. Full examples: [`proxy/api.txt`](proxy/api.txt).

## Documentation index

| Document | Topic |
|---|---|
| [`besu-production/README.md`](besu-production/README.md) | Production Besu: hosts, network files, start, validator add/remove, operations |
| [`mpc-signer/docs/production.md`](mpc-signer/docs/production.md) | Production MPC signer: 3 teams, tokens, key ceremony, backups and restore, operations |
| [`docs/proxy-with-mpc-signer.md`](docs/proxy-with-mpc-signer.md) | Running the proxy on the MPC signer, Redis-optional design, troubleshooting |
| [`mpc-signer/README.md`](mpc-signer/README.md) | MPC signer design, Docker quick start, security notes ([diagram](mpc-signer/docs/architecture.png)) |
| [`mpc-signer/bench/RESULTS.md`](mpc-signer/bench/RESULTS.md) | Throughput: MPC vs Vault + Web3Signer, sizing |
| [`proxy/api.txt`](proxy/api.txt) | Proxy API examples |
| [`proxy/contracts/NftCollection.sol`](proxy/contracts/NftCollection.sol) | NFT collection v2 (price at mint, atomic `buy`) |
