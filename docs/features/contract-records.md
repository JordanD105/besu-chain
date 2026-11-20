# Contract records

> **What:** The contract registry folder `contracts/deployments/`: one JSON record per deployed contract.
> **For:** operators, contract developers.
> **Related:** [contract deployment](contract-deployment.md) · [chainlens](../components/chainlens.md)

**Contents**
- [Two kinds of registration](#two-kinds-of-registration)
- [What a record holds](#what-a-record-holds)
- [Publish a record](#publish-a-record)
- [Register a contract by hand](#register-a-contract-by-hand)

---

## Two kinds of registration

Chainlens gives a contract a name and a function list when it knows the contract's ABI. It learns
it from two places:

| | On-chain registry (SectionRegistry) | Record file (`contracts/deployments/`) |
|---|---|---|
| Written by | the chainlens Deploy page and `POST /nft/deploy`, through the proxy ([contract deployment](contract-deployment.md)) | [`besu-production/operator/deploy-contract.js`](../../besu-production/operator/deploy-contract.js); earlier versions of the Deploy page |
| Deployer | the contract account center | the MPC account given with `--from` |
| Read by | chainlens **and** the proxy (`/contract/call`, `/contract/send`) | chainlens only |
| To publish | nothing: it is on chain | commit the file and run Ansible ([below](#publish-a-record)) |

Prefer the Deploy page for contracts applications will use: a contract that only has a record file
can't be used with `/contract/call` or `/contract/send`. When both exist for one address, chainlens
uses the record file.

## What a record holds

One file per contract, `<address>.json` (lowercase address), written by `deploy-contract.js`:

| Field | |
|---|---|
| `name`, `address`, `chainId` | the contract's name in chainlens, its address, the chain |
| `deployer`, `txHash`, `blockNumber`, `gasUsed`, `deployedAt` | the deployment |
| `artifact`, `constructorArgs` | the artifact file name and the constructor arguments |
| `codeHash` | keccak256 of the runtime code on chain after the deployment |
| `codeCheck` | the result of comparing that code with the artifact (`matches the artifact`, …) |
| `abi` | the ABI, for the contract page |

Records written by earlier versions of the Deploy page are in `/var/lib/chainlens/deployments` on the
monitoring host (`chainlens_local_registry`); `09-monitoring.yml` copies them back here and asks you
to commit them.

## Publish a record

Chainlens reads this directory, mounted read-only at `/registry` (see
[`chainlens/docker-compose.yml`](../../chainlens/docker-compose.yml)). A registered contract gets its
name in the explorer, and its contract page lists its functions and runs the view/pure ones
(`eth_call`, read only). Chainlens itself never signs: its admin pages forward to the proxy.

Commit new records, then run the Ansible deployment again. It copies the committed repository,
this directory included, to the hosts:

```bash
ansible-playbook 01-hosts.yml
```

(or the whole `site.yml`). Chainlens picks the records up within 15 seconds, without a restart.

## Register a contract by hand

A contract deployed another way can be registered by hand: a file `<address>.json` with at least
`name`, `address` and `abi`. Add `codeHash` (the keccak256 of its runtime code) to have chainlens
check that the code on chain is still that code; the contract page shows a warning when it is not.
