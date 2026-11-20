# Introduction

> **What:** what this project is, its components, and the two setups (development and production).
> **For:** everyone, first.
> **Next:** [architecture](architecture.md) · [glossary](../glossary.md) · [documentation map](../README.md)

---

## What it is

A **private Hyperledger Besu blockchain (QBFT consensus)** with everything an organization needs
to run payments and NFTs on it:

- **Applications** call one HTTP API (the **proxy**) to create accounts, move ETH, sell NFTs and call
  contracts. They never hold keys.
- **Keys never exist anywhere**: every account is a **2-of-3 MPC key** split between three MPC nodes
  run by three teams. Two of them must agree to sign; no single machine, team, disk or backup can.
- **Sections** separate business units (shops, departments): each has its own accounts, API key and
  money flow (upfront → users → consumption → payment), recorded on chain.
- **Operations** come with it: high availability on two hosts, monitoring and alerts, backups and a
  disaster-recovery runbook, a block explorer, a self-hosted Remix IDE, and Ansible to deploy it all.

## Components

| Component | Folder | Role | Docs |
|---|---|---|---|
| **Besu (QBFT)** | `besu-production/` | 4 validators + 2 RPC nodes, 1 s blocks, free gas, node allowlist | [Besu manual setup](../deployment/besu-manual.md) |
| **MPC signer** | `mpc-signer/` | 2-of-3 threshold ECDSA (CGGMP24): 3 MPC nodes + 2 coordinators; Web3Signer-compatible API | [MPC signer](../components/mpc-signer.md) |
| **Proxy** | `proxy/` | the application API: accounts, transfers, NFTs, contracts, sections, admin API; Redis as an optional cache | [proxy](../components/proxy.md) · [API](../reference/proxy-api.md) |
| **SectionRegistry** | `proxy/contracts/` | on-chain record of sections, their accounts and registered contracts | [sections](../features/sections.md) |
| **Chainlens** | `chainlens/` | block explorer with platform overview, statistics and admin pages | [chainlens](../components/chainlens.md) |
| **Remix** | `remix/` | self-hosted Remix IDE with a local compiler mirror | [Remix](../components/remix.md) |
| **HA** | `ha/` | HAProxy + keepalived: floating IPs, failover, RPC health check, firewall | [high availability](../deployment/high-availability.md) |
| **Monitoring** | `monitoring/` | Prometheus + Grafana: dashboards and alerts | [monitoring](../components/monitoring.md) · [alerts](../operations/alerts.md) |
| **Ansible** | `ansible/` | deploys and updates everything from the operator machine | [Ansible](../deployment/ansible.md) |
| **Contract records** | `contracts/deployments/` | one JSON record per deployed contract | [contract records](../features/contract-records.md) |

Development-only: `besu-test-network/` (one-host test chain), `mpc-signer/quickstart/` (3 MPC nodes
on one host), `besu-vault-web3signer/` (the retired Vault + Web3Signer signer, kept for benchmarks).

## Two setups

| | Development / test | Production |
|---|---|---|
| **Where** | everything on one Docker host | 5 hosts (`192.168.68.135`–`.139`) |
| **Besu** | `besu-test-network/` (chain id 1337) | `besu-production/` |
| **MPC signer** | `mpc-signer/quickstart/` (3 nodes on one host) | one node per host and team (`mpc-signer/deploy/`) |
| **High availability** | none | HA pair .135 / .136, floating IPs .150 / .151 |
| **Deployment** | Docker Compose by hand | Ansible |
| **Guide** | [development environment](../getting-started/development.md) | [operator guide](../deployment/operator-guide.md) |

The development setup has open ports and test keys: **never use it for production.**
