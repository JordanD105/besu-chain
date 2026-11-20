# Access control

> **What:** Who may connect to each service (proxy, chainlens, Grafana, Remix, the documentation site, the operator), how to allow addresses or networks, and how to check it.
>
> **For:** operators.
>
> **Related:** [Ansible](ansible.md) · [high availability](high-availability.md) · [production layout](../overview/production-layout.md)

**Contents**

- [Admin pages and the proxy admin API](#admin-pages-and-the-proxy-admin-api)
- [Fixed rules (not settings)](#fixed-rules-not-settings)
- [Single addresses and networks](#single-addresses-and-networks)
- [Apply a change](#apply-a-change)
- [Check](#check)
- [Upgrading from client_ips / remix_users](#upgrading-from-client_ips--remix_users)

---

The firewall on every host (`ha/firewall-layout.sh`, applied by `01-hosts.yml`) opens each service
only to the IPs in its list in `group_vars/all/settings.yml`. Everyone else is blocked.

It works in two layers:

| Layer | Covers | Where |
|---|---|---|
| firewalld rich rules | ports of the host itself (SSH, HAProxy, Besu nodes with host networking, VRRP) | default zone; `firewall-cmd --list-rich-rules` |
| nftables table `inet besu_docker` | ports Docker publishes (proxy, coordinator, MPC node, Grafana, chainlens, Remix, documentation site, redis-exporter, Besu nodes without host networking): Docker forwards these itself, past firewalld | rules in `/etc/besu-docker-firewall.rules`, applied by `/usr/local/sbin/besu-docker-firewall`, at boot by `besu-docker-firewall.service` |

Both layers get the same allow list. The nftables table is separate from Docker's and firewalld's
own rules, so neither a Docker restart nor a firewalld reload opens a gap (Docker's `DOCKER-USER`
chain is not used). In it, only listed sources may open a new connection to a published port;
every other new connection is dropped. Ports per host: [Production layout](../overview/production-layout.md),
section 3.

| Setting | Service | Port |
|---|---|---|
| `operator_ip` | the operator / bastion: SSH, MPC admin API, Besu RPC, **and every service below** | 22, 8545, 8555, 9100, … |
| `proxy_client_ips` | applications calling the proxy API | VIP `.151:30000` |
| `chainlens_ips` | users of chainlens, the block explorer | monitoring host `:30100` |
| `grafana_ips` | users of Grafana, the monitoring dashboards | monitoring host `:3000` |
| `remix_ips` | developers using the Remix IDE | monitoring host `:30200` |
| `docs_ips` | readers of the documentation website ([Documentation website](../components/docs-site.md)) | monitoring host `:30300` |
| `chainlens_deploy_ips` | admin PCs using the chainlens admin pages (below) | monitoring host `:30100`, only while `chainlens_deploy_enabled` or `chainlens_sections_enabled` is on |

**Sections** ([Sections](../features/sections.md)) are identified by their API key: a
section's applications need their addresses in `proxy_client_ips` to reach the proxy at all.

`operator_ip` is one address, required: the firewall only lets it in for SSH, so a wrong value
locks you out. The lists may be empty (then only the operator reaches that service).

## Admin pages and the proxy admin API

Two admin layers sit on top of the firewall. Both check a token **and** the caller's address:

| What | Who | Token |
|---|---|---|
| chainlens Deploy page (`#/deploy`, `chainlens_deploy_enabled`) and Sections page (`#/sections`, `chainlens_sections_enabled`) | `operator_ip` and `chainlens_deploy_ips` (not `chainlens_ips`) | `state/secrets/chainlens_deploy_token` |
| proxy admin API (`/admin/*` on `:30000`), which those pages call | `operator_ip` and the monitoring host (chainlens) | `state/secrets/proxy_admin_token` |

Users in `chainlens_ips` see the explorer but not the admin pages. Whoever can use the admin pages
can deploy contracts and move section funds: put admin machines only in `chainlens_deploy_ips`.
More: [Contract deployment (chainlens Deploy page)](../features/contract-deployment.md),
[Sections](../features/sections.md), [Proxy API](../reference/proxy-api.md).

## Fixed rules (not settings)

These follow from the layout (`inventory.yml`), not from the access lists:

| Port | Open to | On |
|---|---|---|
| 22 (SSH) | `operator_ip` | every host |
| 9101 (node-exporter) | the monitoring host | every host |
| 30303 tcp/udp (validator p2p), 30304 tcp/udp (RPC node p2p) | the Besu hosts | Besu hosts (30304 on the HA pair) |
| 9545, 9546 (Besu metrics) | the monitoring host | Besu hosts (9546 on the HA pair) |
| 8545 (HAProxy on the RPC VIP) | the HA pair, `operator_ip` | HA pair |
| 8555 (RPC node direct) | the HA pair, the monitoring host, `operator_ip` | HA pair |
| 9100 (coordinator) | the HA pair, the MPC hosts, the monitoring host, `operator_ip` | HA pair |
| 30000 (proxy) | `proxy_client_ips`, the monitoring host, `operator_ip` | HA pair |
| 9121 (redis-exporter) | the monitoring host | HA pair |
| VRRP | the other HA host | HA pair |
| 7000 (MPC node) | the HA pair (the coordinators) | MPC hosts |

## Single addresses and networks

Each list takes single IPv4 addresses and whole networks in CIDR form, mixed:

```yaml
proxy_client_ips: [192.168.68.21, 192.168.68.22]
chainlens_ips: [192.168.68.0/24]
grafana_ips: [192.168.68.0/24, 10.1.2.9]
remix_ips: [10.1.5.0/26]
```

Wildcards like `192.168.68.*` are not accepted (preflight stops with a message); write the network
instead:

| Wildcard (not accepted) | CIDR to write | Covers |
|---|---|---|
| `192.168.68.*` | `192.168.68.0/24` | `192.168.68.0` – `192.168.68.255` |
| — | `192.168.68.0/25` | `192.168.68.0` – `192.168.68.127` |
| — | `192.168.68.128/26` | `192.168.68.128` – `192.168.68.191` |
| `192.168.*.*` | `192.168.0.0/16` | `192.168.0.0` – `192.168.255.255` |

**Careful with the servers' own subnet.** A network such as `192.168.68.0/24` lets *every* machine on
that LAN in, not only your PCs. For chainlens, Grafana, Remix and the documentation site that is usually fine. For
`proxy_client_ips` it means any machine on the LAN can call the proxy API (create accounts, send
transfers), so list the application hosts one by one there.

## Apply a change

Edit `group_vars/all/settings.yml`, then:

```bash
ansible-playbook 01-hosts.yml
```

Preflight (`00-preflight.yml`, also the first phase of `site.yml`) checks that `proxy_client_ips`,
`chainlens_ips`, `grafana_ips`, `remix_ips` and `chainlens_deploy_ips` hold IPv4 addresses or
networks (`docs_ips` is not checked there yet: write it the same way). To check before applying:

```bash
ansible-playbook 00-preflight.yml
```

`operator_ip` and `chainlens_deploy_ips` are also written into the proxy and chainlens settings
(the admin allow lists above), and turning an admin page on or off changes chainlens. After changing
those, run the whole deployment instead:

```bash
ansible-playbook site.yml
```

**Removing an address or network:** the rules for the Docker-published ports (proxy, chainlens,
Grafana, Remix, documentation site) are rewritten on every run, so it loses access to those at once. The firewalld rules
are only added, never removed by Ansible; delete the one you no longer want on the host:

```bash
firewall-cmd --permanent --list-rich-rules | grep <IP or network>
```

```bash
firewall-cmd --permanent --remove-rich-rule='<the rule exactly as listed>' && firewall-cmd --reload
```

## Check

On a host, what is allowed for the Docker-published ports (the rules file, then what is loaded in
nftables):

```bash
cat /etc/besu-docker-firewall.rules
```

```bash
nft list table inet besu_docker
```

```bash
systemctl status besu-docker-firewall
```

The firewalld rules:

```bash
firewall-cmd --list-rich-rules
```

From a machine, whether it gets in (`open`) or not (`blocked`), e.g. Grafana:

```bash
timeout 3 bash -c '</dev/tcp/192.168.68.139/3000' && echo open || echo blocked
```

## Upgrading from client_ips / remix_users

Older versions had `client_ips` (proxy and chainlens together) and `remix_users`. Preflight stops
while they are still set (Grafana users are `grafana_ips`). Move the IPs into `proxy_client_ips` and/or `chainlens_ips`, rename
`remix_users` to `remix_ips`, delete the old lines and run `01-hosts.yml`.

If `git pull` then reports a conflict in `settings.yml` (your values and the new version both
changed it), keep your values under the new names, check that no conflict markers remain, and finish
the merge:

```bash
grep -nE '^(<<<<<<<|=======|>>>>>>>)' group_vars/all/settings.yml
```

```bash
git add group_vars/all/settings.yml && git commit --no-edit && git pull
```
