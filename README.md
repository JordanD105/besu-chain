# besu-chain

A private **Hyperledger Besu (QBFT)** blockchain for payments and NFTs, where **private keys never
exist**: every account is a 2-of-3 MPC key split between three teams. Applications use one HTTP API;
business units (**sections**) get their own accounts, key and money flow on chain. High
availability, monitoring, backups and Ansible deployment are included.

![production architecture](docs/images/architecture-production.png)

## Documentation

**All documentation is in [`docs/`](docs/README.md)**: start with the
[documentation map](docs/README.md), which has reading paths by role and by task.

| Start here | |
|---|---|
| [Introduction](docs/overview/introduction.md) | what it is, the components, development vs production |
| [Architecture](docs/overview/architecture.md) | hosts, floating IPs, zones, request flows, what survives a failure |
| [Proxy API](docs/reference/proxy-api.md) | every endpoint, for application developers |
| [Operator guide](docs/deployment/operator-guide.md) | deploying production with Ansible |
| [Troubleshooting](docs/operations/troubleshooting.md) · [Alerts](docs/operations/alerts.md) | when something is wrong |
| [Glossary](docs/glossary.md) | the terms |

## Repository layout

| Folder | Contains | Docs |
|---|---|---|
| `ansible/` | the production deployment (playbooks, settings, templates) | [Ansible](docs/deployment/ansible.md) |
| `besu-production/` | production Besu packages and operator scripts | [Besu manual setup](docs/deployment/besu-manual.md) |
| `mpc-signer/` | the 2-of-3 MPC signer (Rust), quick start, production packages, benchmark | [MPC signer](docs/components/mpc-signer.md) |
| `proxy/` | the application API (Node.js), NFT and SectionRegistry contracts | [Proxy](docs/components/proxy.md) |
| `chainlens/` | the block explorer | [Chainlens](docs/components/chainlens.md) |
| `remix/` | the self-hosted Remix IDE | [Remix](docs/components/remix.md) |
| `ha/` | HAProxy, keepalived, RPC health check, firewall | [High availability](docs/deployment/high-availability.md) |
| `monitoring/` | Prometheus, Grafana dashboards, alert rules | [Monitoring](docs/components/monitoring.md) |
| `contracts/deployments/` | one record per deployed contract | [Contract records](docs/features/contract-records.md) |
| `besu-test-network/` | one-host test chain (development) | [Development environment](docs/getting-started/development.md) |
| `besu-vault-web3signer/` | the retired Vault + Web3Signer signer | [Vault + Web3Signer](docs/development/vault-web3signer.md) |
| `docs/` | all documentation | [map](docs/README.md) |

## Quick start (development, one host)

```bash
cd besu-test-network && ./run.sh                                         # test chain + monitoring
cd mpc-signer/quickstart && MPC_BIGINT=bigint-rug CHAIN_ID=1337 ./quickstart.sh init
./quickstart.sh up && ./quickstart.sh setup                              # prints SENDER01
cd proxy && docker compose up -d --build                                 # API on :30000
cd chainlens && cp .env.example .env && docker compose up -d --build     # explorer on :30100
```

Settings and first calls: [development environment](docs/getting-started/development.md).
