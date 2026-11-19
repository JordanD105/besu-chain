# Running the Ansible deployment on the operator machine

Step by step, from an empty operator machine to a deployed production layout. What each phase
does, the operator state and reruns are described in [`README.md`](README.md).

## 1. Install the tools on the operator

The operator needs Ansible, Docker, git and curl. It builds the MPC, proxy and chainlens images
and creates the genesis, which is why it needs Docker.

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
git clone https://github.com/JordanD105/besu-chain.git && cd besu-chain/ansible
```

Use the branch that holds the version you want to deploy (`git clone -b <branch> …`).

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
| `vip_rpc`, `vip_proxy`, `vip_prefix` | the two floating IPs and their mask: **unused** addresses in the same subnet as the two HA hosts. With the host IPs in `inventory.yml` (`ansible_host`), they are the whole IP plan: Ansible generates HAProxy, keepalived, firewall and Prometheus files from them ([`README.md`](README.md), "The IP plan") |
| `operator_ip` | **this machine's IP as the hosts see it**. The firewall will only let this IP in, so a wrong value locks you out |
| `client_ips` | the IPs of the applications calling the proxy (and chainlens users), e.g. `[10.1.2.3, 10.1.2.4]` |
| `image_archives_dir` | the folder holding the image archives (`besu-26.11.1-docker.tar`, `grafana-13.2-docker.tar`, `node-exporter-v1.12.1-docker.tar`, `prometheus-3.16.0-docker.tar`, `redis-8.10.3-docker.tar`), e.g. `/opt/images`. Leave it empty to download the images from Docker Hub instead |
| `snapshot_copy_to` | off-site target for the daily chain snapshot, e.g. `backup@offsite:/besu-chain` (optional) |
| `key_backup_gpg_public_key` | path on the operator to **your GPG public key**, e.g. `/opt/000/backup-pub.asc`: create the key pair as in [`GPG-KEY.md`](GPG-KEY.md). Ansible backs up the 6 Besu node keys encrypted with it. Keep the private key offline. Empty: no key backups |
| `mpc_backup_cron` | `true` to let Ansible set up the hourly MPC share backups on the 3 MPC hosts (default `false`: each team does it) |
| `ntp_servers` | your time servers, e.g. `[ntp1.internal.example, 10.0.0.1]`. Empty: the distribution's public servers (needs internet). Hosts without internet access **must** have internal servers here: QBFT rejects blocks with wrong timestamps. The `HostClockNotSynced` alert and the Clock columns of the Hosts dashboard watch it |
| `vrrp_interface` | leave empty: it's detected automatically |

To create the archives (or keep a copy of every image the deployment uses), on the operator:

```bash
ansible-playbook save-images.yml -e image_archives_dir=/opt/000
```

It saves the five third-party images (pulled first if missing) and, once a deployment run has
built them, the MPC signer, proxy and chainlens images, all eight in `/opt/000`. Run it again
after `site.yml` to refresh them.

Everything else (chain id 1337, 1 s blocks, funding of `SENDER01`, image versions) is already
set. Change it only if you want different values. The chain settings can't be changed after the
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

**Run 3** goes to the end in about 5–10 minutes: coordinators, key ceremony, chain, proxy,
HAProxy + keepalived, a test transfer, monitoring, backups. At the end it prints:

- Applications: `http://192.168.68.151:30000`
- Grafana: `http://192.168.68.139:3000`, user `admin`, password in `state/secrets/grafana_admin_password`
- Chainlens: `http://192.168.68.139:30100`

## 7. After the deployment

- **Copy `ansible/state/` to your vault.** It holds the tokens, genesis, `cluster.json` and
  `SENDER01`. Without it Ansible can't update the deployment later.
- **Backups** are set up by the last phase: the daily chain snapshot (and a first one), the 6 node
  keys encrypted in `state/key-backups/` (if `key_backup_gpg_public_key` is set), and the MPC share
  backups if `mpc_backup_cron: true`. Otherwise each **MPC team** sets up its hourly `backup.sh`
  cron (step 5 of their instructions). The backup alerts in Grafana clear when all of them have run.
- **Failover tests**: [`../docs/production-layout.md`](../docs/production-layout.md), section 6.
  Then go live.

## Later

For any change (a setting, a new version, new code), commit it if it's code, then run the same
command again. It only changes what's different:

```bash
ansible-playbook site.yml
```

**If something fails:** read the red message. Fix the cause and run the same command again; it
continues safely from where it stopped. Add `-v` for more detail.
