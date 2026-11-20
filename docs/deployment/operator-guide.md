# Operator guide

> **What:** Deploying production with Ansible from the operator machine, step by step: tools, SSH access, settings, the runs, and what to do afterwards.
>
> **For:** operators (start here for production).
>
> **Related:** [Ansible](ansible.md) · [access control](access-control.md) · [architecture](../overview/architecture.md)

**Contents**

- [1. Install the tools on the operator](#1-install-the-tools-on-the-operator)
- [2. Get the code](#2-get-the-code)
- [3. SSH access to the 5 hosts](#3-ssh-access-to-the-5-hosts)
- [4. Settings](#4-settings)
- [5. Check first](#5-check-first)
- [6. Run](#6-run)
- [7. After the deployment](#7-after-the-deployment)
- [Later](#later)

---

Step by step, from an empty operator machine to a deployed production layout. What each phase
does, the operator state and reruns are described in [Ansible deployment](ansible.md).

## 1. Install the tools on the operator

The operator needs Ansible, Docker, git and curl. It builds the MPC, proxy, chainlens, Remix and
documentation site images and creates the genesis, which is why it needs Docker. With the Remix
IDE on (the default), it fetches the Remix site from github.com once.

RHEL / Rocky / Alma:

```bash
sudo dnf install -y git curl python3-pip && pip3 install --user ansible-core
```

Ubuntu / Debian:

```bash
sudo apt install -y git curl python3-pip pipx && pipx install ansible-core
```

Then install Docker Engine (docs.docker.com, for your distribution) and check everything is there:

```bash
ansible --version && docker version && git --version
```

## 2. Get the code

```bash
git clone https://github.com/JordanD105/besu-chain.git
```

```bash
cd besu-chain/ansible
```

All the commands below run in this `ansible/` folder. Use the branch that holds the version you want to deploy (`git clone -b <branch> …`).

## 3. SSH access to the 5 hosts

Ansible logs in with an SSH key. If you don't have one yet:

```bash
ssh-keygen -t ed25519
```

Copy it to each host (.135 to .139):

```bash
for h in 135 136 137 138 139; do ssh-copy-id root@192.168.68.$h; done
```

Then accept each host key once:

```bash
for h in 135 136 137 138 139; do ssh root@192.168.68.$h hostname; done
```

If you log in as a sudo user instead of root, set `ansible_user: <that user>` in `inventory.yml`,
and add `-K` to every `ansible-playbook` command if sudo asks for a password.

Check that Ansible reaches all hosts:

```bash
ansible servers -m ping
```

## 4. Settings

Edit `group_vars/all/settings.yml`:

| Setting | What to put |
|---|---|
| `vip_rpc`, `vip_proxy`, `vip_prefix` | the two floating IPs and their mask: **unused** addresses in the same subnet as the two HA hosts. With the host IPs in `inventory.yml` (`ansible_host`), they are the whole IP plan: Ansible generates HAProxy, keepalived, firewall and Prometheus files from them ([Ansible deployment](ansible.md), "The IP plan") |
| `operator_ip` | **this machine's IP as the hosts see it**. The firewall will only let this IP in, so a wrong value locks you out |
| `proxy_client_ips` | the IPs of the applications calling the proxy API (`:30000`), e.g. `[10.1.2.3, 10.1.2.4]` |
| `chainlens_ips` | who may open chainlens, the explorer (`:30100`) |
| `grafana_ips` | who may open Grafana, the dashboards (`:3000`) |
| `remix_ips` | developers who may open the Remix IDE (`:30200`) |
| `docs_ips` | who may open the documentation website (`:30300`) |
| `chainlens_deploy_ips` | admin PCs allowed to use the chainlens admin pages (Deploy, Sections) besides `operator_ip`, e.g. `[192.168.68.1]`; only used when one of those pages is on (below) |
| | The access lists take addresses and networks, e.g. `[192.168.68.0/24, 10.1.2.9]` (no `*` wildcards): [Access control](access-control.md) |
| `image_archives_dir` | the folder holding the image archives (`besu-26.11.1-docker.tar`, `grafana-13.2-docker.tar`, `node-exporter-v1.12.1-docker.tar`, `prometheus-3.16.0-docker.tar`, `redis-8.10.3-docker.tar`, `redis-exporter-v1.67.0-docker.tar`), e.g. `/opt/images`. Leave it empty to download the images from Docker Hub instead |
| `snapshot_copy_to` | off-site target for the daily chain snapshot, e.g. `backup@offsite:/besu-chain` (optional) |
| `key_backup_gpg_public_key` | path on the operator to **your GPG public key**, e.g. `/opt/000/backup-pub.asc`: create the key pair as in [GPG key for the node-key backups](gpg-key.md). Ansible backs up the 6 Besu node keys encrypted with it. Keep the private key offline. Empty: no key backups |
| `mpc_backup_cron` | `true` to let Ansible set up the hourly MPC share backups on the 3 MPC hosts (default `false`: each team does it) |
| `ntp_servers` | your time servers, e.g. `[ntp1.internal.example, 10.0.0.1]`. Empty: the distribution's public servers (needs internet). Hosts without internet access **must** have internal servers here: QBFT rejects blocks with wrong timestamps. The `HostClockNotSynced` alert and the Clock columns of the Hosts dashboard watch it |
| `chainlens_sections_enabled` | the Sections page in chainlens (off by default): create and manage sections, top up, sweep, pay back ([Sections](../features/sections.md)); same access and token as the Deploy page (`state/secrets/chainlens_deploy_token`) |
| `upfront_low_balance_eth`, `sender01_low_balance_eth` | alert thresholds in ETH (defaults 100 and 10000; 0 = off): a section's upfront account / SENDER01 below them raises `SectionUpfrontLow` / `Sender01Low` ([Sections](../features/sections.md), Monitoring) |
| `sections_required` | `false` (default): calls without a section key still use SENDER01; `true` once all applications send their `X-Section-Key` ([Sections](../features/sections.md)). With `true` the deployment's one-time test transfer is skipped |
| `chainlens_deploy_enabled`, `chainlens_deploy_ips` | the Deploy page in chainlens (off by default): deploy contracts from the browser through the proxy (contract account center, registered on chain), for `operator_ip` and the admin PCs in `chainlens_deploy_ips`: [Contract deployment (chainlens Deploy page)](../features/contract-deployment.md) |
| `remix_enabled`, `remix_solc_versions` | the self-hosted Remix IDE on the monitoring host (`:30200`, on by default; [Remix IDE (self-hosted)](../components/remix.md)) and the compiler versions it serves (default `["0.8.28"]`): the operator fetches Remix from github.com once |
| `docs_site_enabled` | this documentation as a website on the monitoring host (`:30300`, on by default; [Documentation website](../components/docs-site.md)) |
| `prometheus_retention`, `prometheus_retention_size` | how long Prometheus keeps metrics (default `400d`) and its disk cap (default `20GB`) |
| `rpc_max_block_age`, `rpc_max_blocks_behind`, `rpc_auto_restart_minutes` | when HAProxy takes an RPC node out of the VIP, and when a stalled one is restarted (defaults 30 s, 10 blocks, 5 min): [High availability](high-availability.md), "RPC health" |
| `vrrp_interface` | leave empty: it's detected automatically |

To create the archives (or keep a copy of every image the deployment uses), on the operator:

```bash
ansible-playbook save-images.yml -e image_archives_dir=/opt/000
```

It saves the six third-party images (pulled first if missing) and, once a deployment run has
built them, the MPC signer, proxy, chainlens and Remix images, all ten in `/opt/000` (nine with
`remix_enabled: false`). Run it again after `site.yml` to refresh them.

Everything else (chain id 1337, 1 s blocks, funding of `SENDER01`, image versions) is already
set; each setting is commented in `settings.yml`, and [Ansible deployment](ansible.md), section 2,
describes them all. Change it only if you want different values. The chain settings can't be changed after the
first run.

The hosts receive the **committed** code. If you edit anything outside `settings.yml` and
`inventory.yml`, commit it first. The preflight phase warns you about uncommitted changes.

## 5. Check first

This changes nothing. It checks your settings, the tools, and that each host has its expected IP:

```bash
ansible-playbook 00-preflight.yml
```

## 6. Run

```bash
ansible-playbook site.yml
```

It runs in three passes, because the MPC teams set up their own nodes.

**Run 1** prepares all hosts and builds the images (the first MPC image build takes several
minutes), then stops with "waiting for the MPC teams":

1. Send each team its instructions (`state/handoff/mpc1.md`, `mpc2.md`, `mpc3.md`) and the
   `MPC_NODE_TOKEN` from `state/secrets/mpc_node_token`. Use a secret channel for the token.
2. Each team runs `init.sh` on its host and sends back `node<ID>.json`.
3. Put the three files in `state/mpc/`, then:

```bash
ansible-playbook site.yml
```

**Run 2** creates `state/cluster.json`, prints its sha256 and stops. Send `cluster.json` to the
three teams. Each team checks the sha256, copies the file to its node folder (`mpc_node_dir`,
default `/opt/besu-chain/mpc-signer/deploy/node`) and runs
`docker compose up -d`. Then:

```bash
ansible-playbook site.yml
```

**Run 3** goes to the end in about 5–10 minutes: coordinators, key ceremony, chain, the
SectionRegistry and the contract account center, proxy, HAProxy + keepalived, a test transfer,
monitoring, backups. At the end it prints:

- Applications: `http://192.168.68.151:30000`
- Grafana: `http://192.168.68.139:3000`, user `admin`, password in `state/secrets/grafana_admin_password`
- Chainlens: `http://192.168.68.139:30100`
- Chainlens Deploy page `#/deploy` and Sections page `#/sections`, when on: token in
  `state/secrets/chainlens_deploy_token`, from `operator_ip` and `chainlens_deploy_ips` only
- Remix IDE: `http://192.168.68.139:30200` (compile with EVM version `cancun`)
- The documentation website is at `http://192.168.68.139:30300` (not printed by the run)
- what is still manual (backups, off-site copy, failover tests), and a warning if
  `snapshot_copy_to` is empty

## 7. After the deployment

- **Copy `ansible/state/` to your vault.** It holds the tokens, genesis, `cluster.json`,
  `SENDER01`, the SectionRegistry (`registry.json`) and the contract account center. Without it
  Ansible can't update the deployment later.
- **Backups** are set up by the last phase: the daily chain snapshot (and a first one), the 6 node
  keys encrypted in `state/key-backups/` (if `key_backup_gpg_public_key` is set), and the MPC share
  backups if `mpc_backup_cron: true`. Otherwise each **MPC team** sets up its hourly `backup.sh`
  cron (step 5 of their instructions). The backup alerts in Grafana clear when all of them have run.
- **Failover tests**: [Production layout](../overview/production-layout.md), section 6.
  Then go live.

## Later

For any change (a setting, a new version, new code), commit it if it's code, then run the same
command again. It only changes what's different:

```bash
ansible-playbook site.yml
```

**After a `git pull`:** `site.yml` copies the new code to the hosts first. To run single phases
instead (e.g. `11-chainlens.yml`), run `01-hosts.yml` first: the other phases stop with "The
hosts have older code" until it has copied the current code.

```bash
ansible-playbook 01-hosts.yml
```

**Contract records:** when contracts were deployed from the chainlens Deploy page, phase 9 copies
their records into `contracts/deployments/` and prints the `git add` / `git commit` commands. Commit
them.

**If something fails:** read the red message. Fix the cause and run the same command again; it
continues safely from where it stopped. Add `-v` for more detail.
