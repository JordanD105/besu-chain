# Access control

> **What:** Who may connect to each service (proxy, chainlens, Grafana, Remix, the operator), how to allow addresses or networks, and how to check it.
> **For:** operators.
> **Related:** [Ansible](../deployment/ansible.md) · [high availability](high-availability.md) · [production layout](../overview/production-layout.md)

**Contents**
- [Single addresses and networks](#single-addresses-and-networks)
- [Apply a change](#apply-a-change)
- [Check](#check)
- [Upgrading from client_ips / remix_users](#upgrading-from-clientips--remixusers)

---

The firewall on every host (`ha/firewall-layout.sh`, applied by `01-hosts.yml`) opens each service
only to the IPs in its list in `group_vars/all/settings.yml`. Everyone else is blocked, including
for the ports Docker publishes (see [Production layout](../overview/production-layout.md),
section 3).

| Setting | Service | Port |
|---|---|---|
| `operator_ip` | the operator / bastion: SSH, MPC admin API, Besu RPC, **and every service below** | 22, 8545, 8555, 9100, … |
| `proxy_client_ips` | applications calling the proxy API | VIP `.151:30000` |
| `chainlens_ips` | users of chainlens, the block explorer | monitoring host `:30100` |
| `grafana_ips` | users of Grafana, the monitoring dashboards | monitoring host `:3000` |
| `remix_ips` | developers using the Remix IDE | monitoring host `:30200` |

**Sections** ([Sections](../features/sections.md)) are identified by their API key: a
section's applications need their addresses in `proxy_client_ips` to reach the proxy at all.

The Deploy page of chainlens, when on, is for `operator_ip` and `chainlens_deploy_ips` only (not
`chainlens_ips`): [Contract deployment (chainlens Deploy page)](../features/contract-deployment.md).

`operator_ip` is one address, required: the firewall only lets it in for SSH, so a wrong value
locks you out. The four lists may be empty (then only the operator reaches that service).

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
that LAN in, not only your PCs. For chainlens, Grafana and Remix that is usually fine. For
`proxy_client_ips` it means any machine on the LAN can call the proxy API (create accounts, send
transfers), so list the application hosts one by one there.

## Apply a change

Edit `group_vars/all/settings.yml`, then:

```bash
ansible-playbook 01-hosts.yml
```

Preflight (`00-preflight.yml`, also the first phase of `site.yml`) checks that every list holds IPv4
addresses or networks.

**Removing an address or network:** the rules for the Docker-published ports (proxy, chainlens,
Grafana, Remix) are rewritten on every run, so it loses access to those at once. The firewalld rules
are only added, never removed by Ansible; delete the one you no longer want on the host:

```bash
firewall-cmd --permanent --list-rich-rules | grep <IP or network>
```

```bash
firewall-cmd --permanent --remove-rich-rule='<the rule exactly as listed>' && firewall-cmd --reload
```

## Check

On a host, what is allowed for the Docker-published ports, and the firewalld rules:

```bash
cat /etc/besu-docker-firewall.rules
```

```bash
firewall-cmd --list-rich-rules
```

From a machine, whether it gets in (`open`) or not (`blocked`), e.g. Grafana:

```bash
timeout 3 bash -c '</dev/tcp/192.168.68.139/3000' && echo open || echo blocked
```

## Upgrading from client_ips / remix_users

Older versions had `client_ips` (proxy and chainlens together) and `remix_users`. Preflight stops
while they are still set. Move the IPs into `proxy_client_ips` and/or `chainlens_ips`, rename
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
