# ansible: production deployment from scratch (option B)

Ansible deploys the whole production layout ([`../docs/production-layout.md`](../docs/production-layout.md))
on the 5 hosts. It does everything **except the MPC nodes**: each MPC node team initialises and starts
its own node, so no person or tool holds two key shares. The playbook stops when it needs the teams,
says exactly what they must do, and continues where it stopped when you run it again.

| Phase | Playbook | Where | What |
|---|---|---|---|
| 0 | `00-preflight.yml` | operator, all hosts | settings, tools, host IPs; creates `state/` and the shared secrets |
| 1 | `01-hosts.yml` | all hosts | Docker, firewalld, chrony, cron; repository in `/opt/besu-chain`; firewall (`ha/firewall-layout.sh`); node-exporter |
| 2 | `02-images.yml` | operator → hosts | builds the MPC, proxy and chainlens images **once** and copies them (identical image on every host) |
| 3 | `03-mpc-nodes.yml` | operator | **stops for the MPC teams** (twice): team instructions, `cluster.json`, nodes answering |
| 4 | `04-coordinators.yml` | .135, .136 | coord1 + coord2, key ceremony → `SENDER01`, presignature pool |
| 5 | `05-besu.yml` | .135–.138 | 6 node keys (on their hosts), genesis (once) with `SENDER01` funded, validators, then RPC nodes |
| 6 | `06-proxy.yml` | .135, .136 | proxy settings (not started) |
| 7 | `07-ha.yml` | .135, .136 | HAProxy, keepalived: VIPs on .135, proxy1 started |
| 8 | `08-check.yml` | operator | Besu, MPC and proxy through the VIPs; once: test account + transfer |
| 9 | `09-monitoring.yml` | .139 | Prometheus, Grafana (all targets checked), chainlens |
| 10 | `10-backups.yml` | .137 | daily chain snapshot cron; prints what stays manual |

`site.yml` runs them in order.

**Step-by-step guide for the operator (install, SSH, settings, the three runs):
[`OPERATOR.md`](OPERATOR.md).**

## 1. Requirements

**Operator machine** (the bastion): Ansible (`ansible-core`; tested with 2.22), Docker, git, curl,
SSH key login to the 5 hosts, and a clone of this repository. The hosts get the **committed HEAD**
(uncommitted changes are not deployed; preflight warns about them).

**Hosts:** RHEL family (dnf) or Debian/Ubuntu (apt), with the layout's IPs (192.168.68.135–.139),
an account with sudo (`ansible_user` in `inventory.yml`, default `root`) and Python 3. They need
the package repositories, and Docker Hub for the Besu, node-exporter, Prometheus, Grafana and redis
images unless you give Ansible those images as archives (`image_archives_dir`, below).

## 2. Settings

Edit `group_vars/all/settings.yml`. Required:

| Setting | Value |
|---|---|
| `operator_ip` | the operator's IP as the hosts see it. **The firewall only lets this IP in** (SSH, MPC admin, Grafana): a wrong value locks you out |
| `client_ips` | the applications calling the proxy (`.151:30000`) and chainlens users |
| `snapshot_copy_to` | off-site target for the daily chain snapshot (`user@host:/path`, root's SSH key on .137) |

**Image versions** (exact tags, used on every host):

| Setting | Version | Archive file in `image_archives_dir` |
|---|---|---|
| `besu_image` | `hyperledger/besu:26.11.1` | `besu-26.11.1-docker.tar` |
| `node_exporter_image` | `prom/node-exporter:v1.12.1` | `node-exporter-v1.12.1-docker.tar` |
| `prometheus_image` | `prom/prometheus:v3.16.0` | `prometheus-3.16.0-docker.tar` |
| `grafana_image` | `grafana/grafana:13.2` | `grafana-13.2-docker.tar` |
| `redis_image` | `redis:8.10.3` | `redis-8.10.3-docker.tar` |

Set `image_archives_dir` to a directory on the operator holding these `docker save` archives:
Ansible copies each one only to the hosts that run it and loads it there (no Docker Hub access
needed, no rate limit), and checks that the archive holds exactly that name and tag. Empty: the
hosts pull the images.

To save **all** the deployment's images into that directory (the five above, plus the MPC signer,
proxy and chainlens images that `02-images.yml` builds, as `mpc-signer-<tag>-docker.tar`,
`proxy-docker.tar`, `chainlens-docker.tar`), run on the operator:

```bash
ansible-playbook save-images.yml
```

It pulls missing third-party images, keeps archives that already hold the right image, and
rewrites missing or different ones. The built images are copied from `state/images/`, so run
`site.yml` (or `02-images.yml`) first; a rebuilt proxy or chainlens replaces its archive.

To change a version, set the new tag (and archive file name) and rerun
`site.yml`: Besu nodes are recreated one at a time, each back in sync before the next.

**Presignature pools:** `mpc_pool_target` (big keys such as `SENDER01`), `mpc_pool_target_small`
(small keys) and `mpc_new_account_pool` (the class of accounts from `/createaccount` that name
none: `big`, `small` or `none`). See "Presignature pools" in
[`../mpc-signer/docs/production.md`](../mpc-signer/docs/production.md). When the MPC image version
changes, the MPC node teams upgrade their nodes **before** you rerun `site.yml`:
[`../mpc-signer/docs/upgrade.md`](../mpc-signer/docs/upgrade.md).

Review the rest: chain id, block period, `SENDER01` funding, MPC policy, image names,
`mpc_image_build` (build on the operator, or pull from your registry), `install_packages`.
`build_compose_overrides` adds compose files to the proxy / chainlens builds, e.g. for a build
proxy or a company CA. The layout itself (which node runs where, ports) is in
`group_vars/all/layout.yml` and must match the rest of the repository: don't change it here alone.

## 3. Run

```bash
cd ansible
ansible-playbook site.yml
```

**First stop** (phase 3): "waiting for the MPC teams".

1. Give each team its instructions, `state/handoff/mpc1.md`, `mpc2.md`, `mpc3.md`, and the
   `MPC_NODE_TOKEN` (`state/secrets/mpc_node_token`) over a secret channel.
2. Each team runs `init.sh` on its host (the MPC image is already loaded there), stores its
   passphrase in its own vault, and sends back `node<ID>.json` (public keys only).
3. Put the three files in `state/mpc/` and run `ansible-playbook site.yml` again.

**Second stop:** the playbook built `state/cluster.json` and prints its sha256. Send it to the
three teams; each compares the checksum over a second channel, copies it to `/opt/mpc-node/` and
runs `docker compose up -d`. Run `ansible-playbook site.yml` again.

The third run goes to the end (about 5–10 minutes, plus the MPC image build the first time) and
prints the URLs and the manual steps:

- **Node key backups:** in each `/opt/besu-<node>`: `./backup-key.sh /secure/dir`, then
  `gpg --symmetric` (needs a person for the passphrase).
- **MPC backups:** each team's hourly `backup.sh` cron (step 5 of its instructions).
- **`state/` to your vault** (below).
- **Failover tests:** [`../docs/production-layout.md`](../docs/production-layout.md) section 6, then go live.

## 4. The operator's state (`state/`, never committed)

| Path | Contents | |
|---|---|---|
| `secrets/` | `MPC_NODE_TOKEN`, `MPC_ADMIN_TOKEN`, `MPC_METRICS_TOKEN`, the two VRRP passwords, the Grafana admin password | **secret** |
| `mpc/node*.json`, `cluster.json` | MPC nodes' public keys, the cluster file | public, integrity matters |
| `besu/*.json`, `network/` | Besu nodes' public keys, genesis and network files | public, integrity matters |
| `sender01` | the hot MPC key's address | public |
| `handoff/` | team instructions | public |
| `images/`, `build/`, `repo.tar.gz` | build artefacts | can be deleted |

`state/` is mode 700. Keep a copy in your vault after every change: without it a rerun can't
update the deployment (it refuses to create a second genesis or a second key ceremony).

## 5. Running it again

The playbooks are safe to rerun, and a rerun of an unchanged deployment changes nothing.
Created **once and never again**: node keys, the genesis and network files, `cluster.json`, the
key ceremony (`SENDER01`), the tokens, the Grafana password, the smoke test.

To change something, edit the setting (or commit the code change) and rerun `site.yml`:
- `.env` changes recreate only the affected containers; Besu nodes and coordinators are updated
  one host at a time.
- HAProxy and keepalived are **reloaded**, not restarted, so the VIPs stay where they are.
- New proxy / chainlens code: rebuilt on the operator, copied only when the image content changed;
  the running proxy is recreated (seconds).
- New image versions: Besu nodes are replaced one at a time (validators, then RPC nodes), each in
  sync before the next; in the lab, the chain kept producing blocks during the upgrade (longest
  pause about 16 s, when the restarting validator's turn to propose came up).
- If `state/network` is lost while the nodes have network files, phase 5 stops: copy `network/`
  from a node into `state/network/`.

Limits:
- Firewall rules are only **added**: a client IP removed from `client_ips` stays allowed until you
  remove its rule (`firewall-cmd --permanent --remove-rich-rule=…`, `firewall-cmd --reload`).
- Changing the chain settings after the first run has no effect (the genesis is never recreated).

## 6. Security notes

- The MPC nodes are never touched by Ansible: no task reads or writes `/opt/mpc-node`, and the
  passphrases never reach the operator. But in this layout the MPC nodes share their hosts with
  operator-managed components (mpc1 with val1 on .135, mpc2 with val3, mpc3 with val4), and root
  on a host can read anything on it. For real separation, the operator account needs no root on
  .135/.137/.138 beyond what Docker requires, or each MPC team gets its own host.
- `state/secrets` and the hosts' `.env` files hold the tokens: mode 600, root only.
- The Grafana password is in `state/secrets/grafana_admin_password` (not printed).

## 7. How it was tested

End to end on 5 lab hosts (Ubuntu 24.04 containers with systemd, sshd and Docker, on
192.168.68.0/24), driven from an operator:
- the three runs above, with the MPC teams' steps done by hand from the generated instructions;
- a fourth run with no changes: `changed=0` on every host;
- .135 powered off: VIPs on .136 within seconds, proxy2 started, a transfer signed by coord2 with
  mpc2 + mpc3 and sent through rpc2;
- .135 and then .136 rebooted: RPC nodes back in sync on their own, never two proxies running,
  transfers continue with the right nonces;
- `state/network` removed: phase 5 refuses to create a new genesis;
- all 5 hosts powered off at once and on again: no action needed, blocks resumed at 1/s after
  about 3 minutes of QBFT round changes, VIPs back on .135 with one proxy;
- upgrade of the running deployment to the image versions above from `docker save` archives,
  with transfers still working afterwards and the next run at `changed=0`.

Not exercised in the lab: the `dnf` (RHEL family) package path, SELinux, and clock
synchronisation (the lab has no NTP access).
