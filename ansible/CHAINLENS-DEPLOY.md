# Deploying contracts from chainlens (the Deploy page)

Chainlens can deploy a compiled contract from the browser: **Blockchain → Deploy**
(`http://<monitoring host>:30100/#/deploy`). The transaction is signed by one fixed MPC account
(2 of the 3 MPC nodes), with the same checks as
[`besu-production/operator/deploy-contract.js`](../besu-production/README.md#deploying-a-contract):
both use `chainlens/deploy.js`.

It is **off by default**, and when on it is protected three ways:

| Protection | How |
|---|---|
| Who | only from `operator_ip`; for every other address the page and its menu entry don't exist (other chainlens users see nothing) |
| Token | a 48-character token Ansible generates once: `state/secrets/chainlens_deploy_token` |
| Account | always the one `chainlens_deployer`; SENDER01 is refused |

## Turn it on

**1. A deployer account**, once: an MPC key used only for deployments (gas is free, so no funds):

```bash
curl -s -X POST http://192.168.68.151:30000/createaccount -H 'content-type: application/json' -d '{"amount":"0","pool":"none"}'
```

**2. Settings** (`group_vars/all/settings.yml`), with the `address` it returned:

```yaml
chainlens_deploy_enabled: true
chainlens_deployer: "0x…"
```

**3. Apply:**

```bash
ansible-playbook 09-monitoring.yml
```

**4. The token**, on the operator (you type it into the page):

```bash
cat state/secrets/chainlens_deploy_token
```

## Deploy

1. Compile with **EVM version cancun** (Remix: [`../remix/README.md`](../remix/README.md)) and keep
   the compiler artifact (`.json` with ABI and bytecode: Remix `contracts/artifacts/<Name>.json`,
   Hardhat, Foundry or solc output).
2. On the operator machine, open `http://192.168.68.139:30100/#/deploy`.
3. **Deploy token:** paste the token. It is kept for this browser tab only.
4. **Compiler artifact:** choose the file. With several contracts in it, choose the **Contract**.
5. **Constructor arguments:** one box per argument. Numbers as whole numbers (`1000000`),
   addresses `0x…`, `true`/`false`, arrays and tuples as JSON (`["0xabc…","0xdef…"]`).
6. **Name in the registry:** optional, the contract's name in chainlens.
7. **Check:** every check runs (deployer, arguments, gas, the creation doesn't revert) and the page
   shows the address the contract will get. Nothing is signed.
8. **Deploy:** confirm. The MPC nodes sign, the transaction is sent, the page waits for the block and
   compares the code on chain with the artifact. Then it links to the contract's page, where its read
   functions work right away.

Changing a file, an argument or the name after **Check** requires a new check. If the deployer's
state changed in between (another deployment), **Deploy** refuses and asks for a new check.

## The records

A deployment's record (name, address, ABI, transaction) is saved on the monitoring host in
`/var/lib/chainlens/deployments/`, so chainlens shows the contract at once. To keep it in the
repository (the source of truth, also for a rebuilt host), every run of `09-monitoring.yml` (or
`site.yml`) copies those records to the operator's `contracts/deployments/` and lists the ones not
committed yet. Commit them:

```bash
git add ../contracts/deployments && git commit -m "Contract deployments"
```

## Turn it off

```yaml
chainlens_deploy_enabled: false
```

```bash
ansible-playbook 09-monitoring.yml
```

To change the token, delete `state/secrets/chainlens_deploy_token` and run `09-monitoring.yml`.

## If something fails

| Message | Cause |
|---|---|
| (no Deploy entry in the menu) | off, or your browser's address is not `operator_ip` (e.g. through a VPN or another bastion) |
| wrong deploy token | the token doesn't match `state/secrets/chainlens_deploy_token` |
| `… is not an MPC key of the coordinator` | `chainlens_deployer` is not an MPC account |
| `constructor(…) does not take …` | wrong number or type of arguments |
| `the deployment reverts or is invalid` | the constructor fails, or the code was compiled for a newer EVM than cancun |
| `policy: contract creation not allowed` | the MPC nodes' `ALLOWED_TO` is set; it must be empty for deployments |
| `the deployer's state changed since the check` | click **Check** again |

Chainlens logs every deployment with the requester's address: `docker logs chainlens-chainlens-1`
on the monitoring host.
