# Documentation

Everything about **besu-chain**: a private Hyperledger Besu (QBFT) chain with MPC signing (keys never
exist), an application API with sections and NFTs, high availability, monitoring and Ansible deployment.

**New here?** Read [introduction](overview/introduction.md) → [architecture](overview/architecture.md)
→ [glossary](glossary.md).

---

## Start by role

| You are… | Read in this order |
|---|---|
| **New to the project** | [introduction](overview/introduction.md) · [architecture](overview/architecture.md) · [glossary](glossary.md) |
| **Application developer** (calling the API) | [proxy API](reference/proxy-api.md) · [sections](features/sections.md) · [NFT workflow](features/nft-workflow.md) · [development environment](getting-started/development.md) |
| **Operator** (deploying, running production) | [operator guide](deployment/operator-guide.md) · [Ansible](deployment/ansible.md) · [access control](deployment/access-control.md) · [alerts](operations/alerts.md) · [dashboards](operations/dashboards.md) · [troubleshooting](operations/troubleshooting.md) |
| **MPC node team** (one of the three) | [MPC signer](components/mpc-signer.md) · [MPC production](deployment/mpc-signer-production.md) · [MPC upgrade](operations/mpc-signer-upgrade.md) |
| **Business admin** (sections, money, NFTs) | [sections](features/sections.md) · [chainlens](components/chainlens.md) · [NFT workflow](features/nft-workflow.md) |
| **Contract developer** | [Remix](components/remix.md) · [contract deployment](features/contract-deployment.md) · [contract records](features/contract-records.md) |
| **On call, something is wrong** | [troubleshooting](operations/troubleshooting.md) · [alerts](operations/alerts.md) · [disaster recovery](operations/disaster-recovery.md) |

## Start by task

| I want to… | Go to |
|---|---|
| deploy production from scratch | [operator guide](deployment/operator-guide.md) |
| update production after a `git pull` | [Ansible: reruns](deployment/ansible.md) (phase `01` first) |
| allow a PC or network to reach a service | [access control](deployment/access-control.md) |
| create a section, top it up, sweep, pay back | [sections](features/sections.md) |
| deploy a contract from the browser | [contract deployment](features/contract-deployment.md) |
| go from Solidity to an NFT sale | [NFT workflow](features/nft-workflow.md) |
| understand an alert | [alerts](operations/alerts.md) |
| fix an alert | [alert runbook](operations/alert-runbook.md) |
| read a Grafana dashboard | [Grafana dashboards](operations/dashboards.md) |
| recover a lost host or site | [disaster recovery](operations/disaster-recovery.md) · [restore with Ansible](operations/restore.md) |
| upgrade the MPC signer | [MPC upgrade](operations/mpc-signer-upgrade.md) |
| run everything on one machine | [development environment](getting-started/development.md) |

---

## All documents

### Overview
| Document | Contents |
|---|---|
| [Introduction](overview/introduction.md) | what the project is, components, development vs production |
| [Architecture](overview/architecture.md) | hosts, floating IPs, network zones, request flows, failure table, known gaps |
| [Production layout](overview/production-layout.md) | every host, port and setting; manual deployment from scratch; failover tests |
| [Glossary](glossary.md) | the terms used everywhere |

### Getting started
| Document | Contents |
|---|---|
| [Development environment](getting-started/development.md) | the whole stack on one Docker host, first calls, benchmark |

### Deployment
| Document | Contents |
|---|---|
| [Operator guide](deployment/operator-guide.md) | step by step on the operator machine: tools, SSH, settings, the runs, afterwards |
| [Ansible](deployment/ansible.md) | settings, phases, the MPC team steps, operator state, reruns, security |
| [Access control](deployment/access-control.md) | who may connect to each service; addresses and networks; firewall |
| [High availability](deployment/high-availability.md) | HAProxy, keepalived, floating IPs, RPC health check, failover tests |
| [Besu manual setup](deployment/besu-manual.md) | Besu packages by hand: network files, start, add / remove validators |
| [MPC signer production](deployment/mpc-signer-production.md) | the three teams, tokens, key ceremony, backups, operations |
| [GPG key](deployment/gpg-key.md) | the key that encrypts node-key backups |

### Components
| Document | Contents |
|---|---|
| [Proxy](components/proxy.md) | the application API on the MPC signer, Redis-optional design, troubleshooting |
| [MPC signer](components/mpc-signer.md) | design, quick start, security |
| [Chainlens](components/chainlens.md) | explorer pages, admin pages, settings |
| [Remix](components/remix.md) | the self-hosted IDE |
| [Monitoring](components/monitoring.md) | Prometheus, Grafana dashboards, metrics endpoints, alert list |
| [Documentation website](components/docs-site.md) | this documentation as a self-hosted website (Docker, port 30300) |

### Features
| Document | Contents |
|---|---|
| [Sections](features/sections.md) | business units with their own accounts, key and money flow; the SectionRegistry; contracts; NFT v3; monitoring |
| [Contract deployment](features/contract-deployment.md) | the chainlens Deploy page |
| [Contract records](features/contract-records.md) | `contracts/deployments/`: one record per contract |
| [NFT workflow](features/nft-workflow.md) | Remix → deploy → mint → sell, step by step |

### Operations
| Document | Contents |
|---|---|
| [Alerts](operations/alerts.md) | every alert: when, meaning, what to do |
| [Alert runbook](operations/alert-runbook.md) | the solution for every alert, step by step with commands |
| [Grafana dashboards](operations/dashboards.md) | every dashboard and panel: what it shows, healthy values, what to do |
| [Troubleshooting](operations/troubleshooting.md) | symptoms → cause → check → fix |
| [Disaster recovery](operations/disaster-recovery.md) | backups, schedule, recovery per scenario, drills |
| [Restore with Ansible](operations/restore.md) | rebuilding the whole site from the backups |
| [MPC signer upgrade](operations/mpc-signer-upgrade.md) | rolling upgrade and rollback |

### Reference
| Document | Contents |
|---|---|
| [Proxy API](reference/proxy-api.md) | every endpoint with bodies, answers and errors |
| `ansible/group_vars/all/settings.yml` | every setting, commented in the file itself |

### Development
| Document | Contents |
|---|---|
| [MPC benchmarks](development/mpc-benchmarks.md) | signing throughput and latency of the MPC signer, sizing; raw runs in `mpc-signer/bench/results/` |
| [Paladin](development/paladin.md) | privacy nodes of the test network |

---

## Conventions

- Every document starts with **What / For / Related**, then a table of contents when it is long.
- Commands are in their own `bash` blocks; run Ansible commands from `ansible/` on the operator.
- Hosts are named by their last octet (**h135** = `192.168.68.135`); production addresses are the
  defaults of `ansible/inventory.yml` and `settings.yml`.
- Times on Grafana are your browser's local time; logs and `journalctl` on the hosts may be UTC.
- Images are in [`docs/images/`](images/).
