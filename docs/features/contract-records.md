# Contract registry

One JSON record per deployed contract, `<address>.json`, written by
[`besu-production/operator/deploy-contract.js`](../../besu-production/operator/deploy-contract.js)
or by chainlens' Deploy page ([`ansible/CHAINLENS-DEPLOY.md`](../../ansible/CHAINLENS-DEPLOY.md):
copied here by `09-monitoring.yml`):
name, address, deployer, deployment transaction and block, constructor arguments, the hash of the
runtime code and the ABI.

Chainlens reads this directory (mounted read-only at `/registry`, see
[`chainlens/docker-compose.yml`](../../chainlens/docker-compose.yml)). A registered contract gets its
name in the explorer, and its contract page lists its functions and runs the view/pure ones
(`eth_call`, read only). Chainlens never sends transactions.

Commit new records. Then run the Ansible deployment again (`ansible-playbook site.yml`, or only
`01-hosts.yml`), which copies the committed repository, this directory included, to the hosts;
chainlens picks the records up within 15 seconds, without a restart.

A contract deployed another way can be registered by hand: a file `<address>.json` with at least
`name`, `address` and `abi` (add `codeHash`, the keccak256 of its runtime code, to have chainlens
check that the code on chain is still that code).
