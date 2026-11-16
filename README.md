# besu-chain

A private Hyperledger Besu (QBFT) network with:
- an application API (`proxy/`) for accounts, transfers and NFTs
- a block explorer (`chainlens/`) and monitoring
- non-exportable transaction signing with a 2-of-3 MPC signer (`mpc-signer/`), where the private key never exists anywhere. It replaces the current Vault + Web3Signer setup.

## Production architecture

![besu-chain production architecture](docs/architecture-production.png)

<sub>Source: [`docs/architecture-production.svg`](docs/architecture-production.svg)</sub>

### Network zones

| Zone | Contents | Reachable from |
|---|---|---|
| **Public edge** | L7 load balancer / API gateway (HA pair): TLS 1.3, client authentication (API key, OAuth2 or mTLS), per-client rate limits, WAF | internet (the only public entry) |
| **App zone** (private subnets, ≥ 2 AZs) | `proxy` × N (stateless, autoscaled), Redis HA (Sentinel, AOF, AUTH + TLS), `chainlens` × 2 (read-only) | gateway only |
| **Signing zone** (isolated, mTLS only, no internet egress) | `mpc-coordinator` × 2 behind an internal LB; `mpc-node` 0/1/2 on **3 sites run by 3 different admin teams** | proxy → coordinator; coordinator → nodes; bastion for admin |
| **Chain zone** | RPC nodes × 2+ (internal LB, non-validating); 4 QBFT validators, one per failure domain; a separate read-only RPC node for the explorer | signing + app zones (RPC only); validators: p2p only |
| **Ops** | Prometheus + Alertmanager, Grafana, Loki + Alloy, Tempo; per-site secret stores; bastion + MFA; CI with pinned, signed images | scrapes metrics; cannot call signing APIs |

### Request path (`POST /transfer`)

1. The client calls the API gateway, which checks TLS, authentication and rate limits, then routes to any proxy replica.
2. The proxy takes the sender's lock in Redis, takes the next nonce with Redis `INCR`, and checks the balance, including value still pending.
3. The proxy calls `eth_sendTransaction` on `mpc-coordinator` over mTLS. This is the same JSON-RPC Web3Signer exposes.
4. The coordinator asks 2 of the 3 MPC nodes for partial signatures. Each node checks the transaction against its policy (chain id, value and gas limits, allowlist) before signing, using a single-use presignature. The coordinator combines the partials into a normal ECDSA signature.
5. The signed raw transaction goes through the RPC load balancer to the validators, which include it in a block (QBFT, about 1 s).
6. The proxy returns the tx hash. `chainlens` shows the transaction after its next poll of its own read-only RPC node.

### What keeps running when something fails

| Failure | Effect |
|---|---|
| 1 proxy, coordinator, RPC node or Redis node | none: replicas and failover take over |
| 1 MPC node, site or admin team | none: the other 2 of 3 still sign (alert: no redundancy left) |
| 1 validator | none: 4 validators, quorum 3. Grow to 7 to tolerate 2. |
| theft of 1 MPC node, its disk or its backup | attacker gets no key and cannot sign |
| presignature pool empty under sustained load | signing slows to the cold path (about 0.6 s per signature) and an alert fires. Size MPC node CPU at about 0.4 cores per sustained TPS (see [`mpc-signer/bench/RESULTS.md`](mpc-signer/bench/RESULTS.md)). |

### Hardening the test setup needs before production

The repository today is a single-host test setup. These items are drawn in the production
diagram but are **not done yet**:

- **proxy, before running more than one replica:**
  - The per-sender lock (`withSenderLock`) and the account lock live in the process's memory. Move them to Redis.
  - Add nonce-gap repair and a resync from `eth_getTransactionCount`.
  - Make `/createaccount` create MPC keys (`POST /admin/keys`) instead of storing private keys in Vault.
- **mpc-signer:**
  - Add mTLS on the node API and authentication on the relay. Today these use a bearer token, but message contents are already end-to-end signed and encrypted.
  - Support EIP-1559 transactions if needed.
  - Pin and review `cggmp24`: 0.7 is an alpha release, and its audit covers an earlier version.
- **Besu** (`besu-test-network/config/besu/config.toml` today):
  - Remove `ADMIN`, `DEBUG`, `TRACE` and `PERM` from client-facing RPC nodes.
  - Replace `host-allowlist=["*"]` and the `*` CORS settings.
  - Stop exposing validator RPC ports.
  - Load node keys from a secret store.
- **Redis:** run primary + replica with Sentinel, AOF, AUTH and TLS. Today it is a single instance.
- **Ops:** set up Alertmanager rules (alert list in the diagram), per-team backups of MPC shares, Besu snapshots, and restore drills.

### Components

| Folder | Role in production | Ports (test setup) |
|---|---|---|
| [`besu-test-network/`](besu-test-network) | Besu QBFT network: 4 validators + `rpcnode`, chain id 1337, 1 s blocks, zero gas price, node permissioning. Observability: Prometheus, Grafana, Loki + Alloy, Tempo + OpenTelemetry Java agent. The Chainlens services bundled in this compose file are not used. | 8545/8546 rpcnode, 21001–21004 validators, 9090, 3000, 3100 |
| [`proxy/`](proxy) | Application API: `POST /createaccount`, `/transfer`, `/nft/deploy`, `/nft/mint`, `/nft/transfer`, plus read endpoints. Redis holds nonces, pending value and NFT metadata. | 30000 API, 36379 Redis |
| [`chainlens/`](chainlens) | The block explorer in use: Node.js/Express web UI for blocks, transactions, accounts, contracts and NFTs. Polls RPC every 4 s and keeps its index in memory. Runs with Docker (`docker compose up -d --build`, set `BESU_RPC` in `.env`). | 30100 |
| [`mpc-signer/`](mpc-signer) | Non-exportable 2-of-3 signer (CGGMP24 / LFDT Lockness), Web3Signer-compatible. Production: [`mpc-signer/docs/production.md`](mpc-signer/docs/production.md) with per-role packages in `mpc-signer/deploy/`. | 9100 coordinator, 7000 nodes |
| [`besu-vault-web3signer/`](besu-vault-web3signer) | Current signer, to be retired: Vault KV keeps exportable private keys, and Web3Signer loads them into memory. | 8200 Vault, 9000 Web3Signer |

MPC signer internals:

![mpc-signer architecture](mpc-signer/docs/architecture.png)

Details: [`mpc-signer/README.md`](mpc-signer/README.md) (quick start, production deployment,
security notes) and [`mpc-signer/bench/RESULTS.md`](mpc-signer/bench/RESULTS.md) (throughput vs
Vault + Web3Signer).

## Guides

- [Run the proxy with the MPC signer (no Vault, no Web3Signer)](docs/proxy-with-mpc-signer.md): step-by-step from a fresh start
- [Deploy the MPC signer in production](mpc-signer/docs/production.md): three node hosts and teams, coordinators, key ceremony, backups and operations

## Development / test environment

Everything runs on one host with Docker Compose. Both signers are available side by side for
comparison, and all ports are open. Use it for development and benchmarks only.

![besu-chain test environment](docs/architecture-dev.png)

<sub>Source: [`docs/architecture-dev.svg`](docs/architecture-dev.svg)</sub>

```bash
# 1. Besu network + monitoring
cd besu-test-network && ./run.sh

# 1b. Block explorer in Docker (http://localhost:30100)
cd chainlens && cp .env.example .env && docker compose up -d --build

# 2. Signer: the MPC signer (Docker) ...
cd mpc-signer/quickstart && ./quickstart.sh init && ./quickstart.sh up && ./quickstart.sh setup
#    ... or the current one: see besu-vault-web3signer/README.md

# 3. Proxy API (set BESU_IP, WEB3SIGNER_IP/PORT, REDIS_* in proxy/.env)
cd proxy && docker compose up -d --build

# Benchmark old vs new signer against your running stack
cd mpc-signer && OLD_STACK=existing bench/run-bench.sh
```
