# Contract deployment (chainlens Deploy page)

> **What:** Deploying compiled contracts from the chainlens Deploy page, signed by the contract account center and registered on chain.
> **For:** operators, contract developers.
> **Related:** [Remix](../components/remix.md) · [NFT workflow](nft-workflow.md) · [contract records](contract-records.md)

**Contents**
- [Turn it on](#turn-it-on)
- [Deploy](#deploy)
- [The records](#the-records)
- [Turn it off](#turn-it-off)
- [If something fails](#if-something-fails)

---

Chainlens can deploy a compiled contract from the browser: **Blockchain → Deploy**
(`http://<monitoring host>:30100/#/deploy`). Chainlens hands it to the proxy, which deploys it
signed by the **contract account center** (an MPC key, 2 of the 3 MPC nodes) and registers it on
chain in the SectionRegistry with its kind and ABI ([Sections](sections.md),
"Contracts"). The contract is then visible in chainlens and usable by applications
(`/contract/call`, `/contract/send`) at once.

It is **off by default**, and when on it is protected three ways:

| Protection | How |
|---|---|
| Who | only from `operator_ip` and `chainlens_deploy_ips`; for every other address the page and its menu entry don't exist (other chainlens users see nothing) |
| Token | a 48-character token Ansible generates once: `state/secrets/chainlens_deploy_token` |
| Account | always the contract account center (`state/contract-center`, created by `06-proxy.yml`) |

## Turn it on

**1. Settings** (`group_vars/all/settings.yml`):

```yaml
chainlens_deploy_enabled: true
chainlens_deploy_ips: [192.168.68.1]   # optional: admin PCs besides operator_ip
```

`chainlens_deploy_ips` takes addresses or networks (`192.168.68.0/24`). Everyone listed can deploy
contracts with the token, so list admin machines only, not a whole office network. Ansible opens
chainlens's port for them as well (no need to repeat them in `chainlens_ips`).
(`chainlens_deployer` from earlier versions is no longer used.)

**2. Apply** (phase 01 first after a `git pull`: it copies the new code, which the image build of
phase 02 uses; phase 06 creates the contract account center):

```bash
ansible-playbook 01-hosts.yml 02-images.yml 06-proxy.yml 09-monitoring.yml
```

**3. The token**, on the operator (you type it into the page):

```bash
cat state/secrets/chainlens_deploy_token
```

## Deploy

1. Compile with **EVM version cancun** (Remix: [Remix IDE (self-hosted)](../components/remix.md)) and keep
   the compiler artifact (`.json` with ABI and bytecode: Remix `contracts/artifacts/<Name>.json`,
   Hardhat, Foundry or solc output).
2. On the operator machine or a PC in `chainlens_deploy_ips`, open
   `http://192.168.68.139:30100/#/deploy`. From any other PC, tunnel through the operator:
   `ssh -L 30100:192.168.68.139:30100 root@<operator>`, then open `http://localhost:30100/#/deploy`.
3. **Deploy token:** paste the token. It is kept for this browser tab only.
4. **Compiler artifact:** choose the file. With several contracts in it, choose the **Contract**.
5. **Constructor arguments:** one box per argument. Numbers as whole numbers (`1000000`),
   addresses `0x…`, `true`/`false`, arrays and tuples as JSON (`["0xabc…","0xdef…"]`).
6. **Kind:** *Common contract* or *NFT collection*.
7. **Name in the registry:** optional, the contract's name in chainlens.
8. **Check:** every check runs (arguments, gas, the creation doesn't revert) and the page shows the
   address the contract will get. Nothing is signed.
9. **Deploy:** confirm. The MPC nodes sign, the page waits for the block, the code on chain is
   compared with the artifact, and the contract is registered. Then it links to the contract's page,
   where its read functions work right away.

Changing a file, an argument, the kind or the name after **Check** requires a new check. If the
center's state changed in between (another deployment), **Deploy** refuses and asks for a new check.

The contract's deployer (`msg.sender` in its constructor) is the center. A contract with an owner
or roles should take them as constructor arguments when someone else must hold them.

## The records

Contracts deployed here are **registered on chain** (SectionRegistry): nothing to copy or commit.
Contracts deployed with `besu-production/operator/deploy-contract.js` still get a file in
`contracts/deployments/` (commit it); records written by earlier versions of this page are still
copied back to the repository by `09-monitoring.yml`.

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
| (no Deploy entry in the menu) | off, or your browser's address is neither `operator_ip` nor in `chainlens_deploy_ips` (e.g. through a VPN or NAT: chainlens sees the address after it) |
| wrong deploy token / wrong admin token | the token doesn't match `state/secrets/chainlens_deploy_token` |
| `the contract account center is not configured` | run `06-proxy.yml` (it creates the center) |
| `expects N argument(s)` / `constructor arguments: …` | wrong number or type of arguments |
| `the deployment reverts or is invalid` | the constructor fails, or the code was compiled for a newer EVM than cancun |
| `policy: contract creation not allowed` | the MPC nodes' `ALLOWED_TO` is set; it must be empty for deployments |
| `the deployer's state changed since the check` | click **Check** again |

Chainlens and the proxy log every deployment (with the requester's address):
`docker logs chainlens-chainlens-1` on the monitoring host, `docker logs proxy-proxy-1` on the
proxy host.
