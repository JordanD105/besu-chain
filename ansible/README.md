# ansible: production deployment from scratch (option B)

Ansible deploys the whole production layout ([`../docs/production-layout.md`](../docs/production-layout.md))
on the 5 hosts. It does everything **except the MPC nodes**: each MPC node team initialises and starts
its own node, so no person or tool holds two key shares. The playbook stops when it needs the teams,
says exactly what they must do, and continues where it stopped when you run it again.

| Phase | Playbook | Where | What |
|---|---|---|---|
| 0 | `00-preflight.yml` | operator, all hosts | settings, tools, host IPs; creates `state/` and the shared secrets |
| 1 | `01-hosts.yml` | all hosts | Docker, firewalld, chrony, cron; repository in `/opt/besu-chain`; firewall (`ha/firewall-layout.sh`); node-exporter |
| 2 | `02-images.yml` | operator → hosts | builds the MPC, proxy, chainlens and Remix images **once** and copies them (identical image on every host) |
| 3 | `03-mpc-nodes.yml` | operator | **stops for the MPC teams** (twice): team instructions, `cluster.json`, nodes answering |
| 4 | `04-coordinators.yml` | .135, .136 | coord1 + coord2, key ceremony → `SENDER01`, presignature pool |
| 5 | `05-besu.yml` | .135–.138 | 6 node keys (on their hosts), genesis (once) with `SENDER01` funded, validators, then RPC nodes |
| 6 | `06-proxy.yml` | operator, .135, .136 | the SectionRegistry (once: admin MPC key, contract); proxy settings (not started) |
| 7 | `07-ha.yml` | .135, .136 | HAProxy, keepalived: VIPs on .135, proxy1 started |
| 8 | `08-check.yml` | operator | Besu, MPC and proxy through the VIPs; once: test account + transfer |
| 9 | `09-monitoring.yml` | .139 | Prometheus, Grafana (all targets checked), chainlens, Remix IDE ([`../remix/`](../remix/README.md)) |
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

### The IP plan

All addresses come from two places:

| Where | What |
|---|---|
| `inventory.yml` | each host's IP (`ansible_host`). The host names (`h135` …) are only labels |
| `group_vars/all/settings.yml` | `vip_rpc` (HAProxy: Besu RPC `:8545`, MPC signer `:9100`), `vip_proxy` (the proxy `:30000`), `vip_prefix` (their mask length) |

Ansible generates every file that contains addresses from them: HAProxy (`haproxy.cfg`),
keepalived (`keepalived.conf` and its three scripts), the firewall rules on every host, the
Prometheus targets (`/opt/monitoring/prometheus/targets.generated/`), the Besu, coordinator,
proxy and chainlens `.env` files and the MPC team instructions (`MPC_BIND_IP`). The fixed files
in `ha/` and `monitoring/prometheus/targets/` are only for a setup by hand with the documented
addresses.

Rules for a new plan:
- the two HA hosts (`app_hosts`) and both VIPs in the **same subnet** (keepalived moves the VIPs
  with ARP); the VIPs **unused** addresses; `vip_prefix` the subnet's mask length;
- every host reachable from the others on the ports of
  [`../docs/production-layout.md`](../docs/production-layout.md) section 3;
- `operator_ip` and the access lists (`proxy_client_ips`, `chainlens_ips`, `grafana_ips`,
  `remix_ips`, below) in the new network.

Preflight checks that every host really holds its inventory IP, that all addresses are distinct
and that no host uses a VIP. Change the plan **before** the first deployment: the Besu node
addresses (enodes) and the MPC node URLs are written into the genesis files and `cluster.json`
then; moving a deployed node to a new IP follows
[`../docs/disaster-recovery.md`](../docs/disaster-recovery.md) 6.1 "New IP".

### Other settings

**Time:** `ntp_servers` (a list; empty = the distribution's public servers). Phase 1 writes them
into their own chrony file (`/etc/chrony/ntp-servers.conf`, RHEL `/etc/chrony-ntp-servers.conf`)
included from chrony's configuration, comments out the default `pool`/`server` lines, checks the
configuration (`chronyd -p`) and restarts chrony; an empty list restores the defaults. The alert
`HostClockNotSynced` (not synchronized, or more than 100 ms off, for 10 min) and the Clock columns
of the Hosts dashboard watch every host.

Edit `group_vars/all/settings.yml`. Required:

| Setting | Value |
|---|---|
| `operator_ip` | the operator's IP as the hosts see it. **The firewall only lets this IP in** (SSH, MPC admin, Besu RPC, and every service below): a wrong value locks you out |
| `proxy_client_ips` | the applications calling the proxy API (`.151:30000`) |
| `chainlens_ips` | users of chainlens, the explorer (`.139:30100`) |
| `grafana_ips` | users of Grafana, the dashboards (`.139:3000`) |
| `remix_ips` | developers using the Remix IDE (`.139:30200`) |

The access lists take addresses and networks (`192.168.68.0/24`, not `192.168.68.*`); adding,
removing and checking access: **[`ACCESS.md`](ACCESS.md)**.
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
proxy, chainlens and Remix images that `02-images.yml` builds, as `mpc-signer-<tag>-docker.tar`,
`proxy-docker.tar`, `chainlens-docker.tar`, `remix-docker.tar`), run on the operator:

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
three teams; each compares the checksum over a second channel, copies it to its node folder
(`mpc_node_dir`, default `/opt/besu-chain/mpc-signer/deploy/node`) and
runs `docker compose up -d`. Run `ansible-playbook site.yml` again.

The third run goes to the end (about 5–10 minutes, plus the MPC image build the first time) and
prints the URLs and the manual steps:

- **`state/` to your vault** (below), including `state/key-backups/`.
- **MPC backups**, unless `mpc_backup_cron: true`: each team's hourly `backup.sh` cron (step 5
  of its instructions).

Phase 10 sets up the backups (each script reports to monitoring, so the backup alerts clear on
its first run):

| Backup | Done by Ansible | Setting |
|---|---|---|
| Chain snapshot (val3, .137) | daily cron, and a first snapshot now if none exists. If the script refuses (another node is down: stopping val3 could halt the chain), the run warns and continues; the cron retries | `snapshot_first_run`, `snapshot_dir`, `snapshot_copy_to` |
| Node keys (val1–4, rpc1–2) | once per key: copied out of the data volume into a private directory on the host, encrypted there with **your GPG public key**, the plain copy shredded, the encrypted file fetched to `state/key-backups/<node>.key.gpg`. Only your offline private key can read them | `key_backup_gpg_public_key` (empty: skipped) |
| MPC shares (3 nodes) | opt-in (the nodes belong to their teams): hourly cron and a first backup. The archives are sealed (useless without the team's passphrase) and stay on the node's host: each team copies them off it | `mpc_backup_cron` (default `false`), `mpc_backup_dir` |

The GPG key pair (create it, give Ansible only the public half, keep the private half offline,
decrypt for a restore): **[`GPG-KEY.md`](GPG-KEY.md)**.

Restoring everything from these backups after losing the whole site: **[`RESTORE.md`](RESTORE.md)**.
- **Failover tests:** [`../docs/production-layout.md`](../docs/production-layout.md) section 6, then go live.

## 4. The operator's state (`state/`, never committed)

| Path | Contents | |
|---|---|---|
| `secrets/` | `MPC_NODE_TOKEN`, `MPC_ADMIN_TOKEN`, `MPC_METRICS_TOKEN`, the two VRRP passwords, the Grafana admin password, the proxy admin token (`proxy_admin_token`), the chainlens deploy token | **secret** |
| `registry.json`, `registry-admin` | the SectionRegistry's address and its admin MPC key ([`../docs/sections.md`](../docs/sections.md)), created once by `06-proxy.yml` | public, integrity matters |
| `mpc/node*.json`, `cluster.json` | MPC nodes' public keys, the cluster file | public, integrity matters |
| `besu/*.json`, `network/` | Besu nodes' public keys, genesis and network files | public, integrity matters |
| `sender01` | the hot MPC key's address | public |
| `handoff/` | team instructions | public |
| `key-backups/*.key.gpg` | Besu node keys, encrypted to your GPG public key | readable only with your offline private key |
| `images/`, `build/`, `repo.tar.gz` | build artefacts | can be deleted |

`state/` is mode 700. Keep a copy in your vault after every change: without it a rerun can't
update the deployment (it refuses to create a second genesis or a second key ceremony).

## 5. Running it again

The playbooks are safe to rerun, and a rerun of an unchanged deployment changes nothing.
Created **once and never again**: node keys, the genesis and network files, `cluster.json`, the
key ceremony (`SENDER01`), the tokens, the Grafana password, the smoke test.

**Running single phases:** after a `git pull` or a new commit, run `01-hosts.yml` before any other
phase (or the whole `site.yml`). Phase 01 copies the committed code to the hosts, and the image
builds of phase 02 use that copy. Phases 02–10 check this and stop with "The hosts have older code"
if phase 01 didn't run since the last change. A settings-only change needs no phase 01.

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
- Firewall rules are only **added** to firewalld: an IP removed from one of the access lists stays
  allowed to the host's own ports until you remove its rule (`firewall-cmd --permanent
  --remove-rich-rule=…`, `firewall-cmd --reload`). The allow list for the ports Docker publishes
  (proxy, coordinator, MPC node, Grafana, chainlens; nftables table `inet besu_docker`) is rewritten
  completely on every run, so there the IP is removed at once.
- Changing the chain settings after the first run has no effect (the genesis is never recreated).

## 6. Security notes

- The MPC nodes are never started, stopped or configured by Ansible, and the teams' passphrases
  never reach the operator: no task reads or writes the team's `.env`, `cluster.json` or
  `node<ID>.json`. Two exceptions to know: the node folder (`mpc_node_dir`) is inside the
  repository copy that phase 1 refreshes, so a new `docker-compose.yml` or script from the
  repository arrives there with an Ansible run (it takes effect at the team's next
  `docker compose up -d`); and with `mpc_backup_cron: true`, phase 10 runs `backup.sh` there. But
  in this layout the MPC nodes share their hosts with operator-managed components (mpc1 with val1
  on .135, mpc2 with val3, mpc3 with val4), and root on a host can read anything on it. For real
  separation, the operator account needs no root on .135/.137/.138 beyond what Docker requires,
  or each MPC team gets its own host.
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

- a second deployment from scratch on a different subnet (hosts 10.77.0.11–.15, VIPs
  10.77.0.50/.51) with only `inventory.yml` and the VIP settings changed: every generated file
  carried the new addresses, all Prometheus targets up, proxy failover, rerun `changed=0`.

Not exercised in the lab: the `dnf` (RHEL family) package path, SELinux, and clock
synchronisation (the lab has no NTP access).
