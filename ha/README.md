# ha: HAProxy + keepalived for the production layout

> **With the Ansible deployment, the files here are not used as they are:** Ansible generates
> `haproxy.cfg`, `keepalived.conf` and the three scripts from the IP plan (`ansible/inventory.yml`
> and `ansible/group_vars/all/settings.yml`; see [`../ansible/README.md`](../ansible/README.md),
> "The IP plan"), and runs `firewall-layout.sh` with the plan's addresses. The files below, with
> the documented addresses 192.168.68.135–.139, are for a setup by hand.

Two floating IPs on **192.168.68.135** (normally) and **192.168.68.136** (after a failover), so that
losing .135 doesn't stop payments. Layout and settings: [`../docs/production-layout.md`](../docs/production-layout.md).

| VIP | What | Failover |
|---|---|---|
| `192.168.68.150` | HAProxy: `:8545` → rpc1 `:8555` (rpc2 backup), `:9100` → coord1 (coord2 backup) | HAProxy switches backends in ~6 s; keepalived moves the VIP if HAProxy itself fails |
| `192.168.68.151` | the proxy, `:30000` | keepalived moves the VIP and starts proxy2 / stops proxy1 |

| File | Goes to (on .135 and .136) |
|---|---|
| `haproxy.cfg` | `/etc/haproxy/haproxy.cfg` (identical) |
| `keepalived-135.conf` / `keepalived-136.conf` | `/etc/keepalived/keepalived.conf` |
| `check-proxy.sh`, `proxy-start.sh`, `proxy-stop.sh` | `/etc/keepalived/` (chmod 700) |
| `firewall-layout.sh` | run once on **every** host (.135–.139) |

Why this design:
- **One backend at a time** (rpc2 and coord2 are `backup`): the proxy reads nonces from the same
  RPC node the coordinator sends to, and only one presignature pool is consumed. coord2 runs all
  the time with its pool full, and re-reads the key list from the MPC nodes, so it signs for
  every account the moment it takes over.
- **Only one proxy at a time**: the proxy counts nonces per sender in memory. keepalived starts
  the proxy on the host that takes `.151` and stops it on the host that gives it up, and
  `check-proxy.sh` (every 3 s) stops a proxy that runs on the host without `.151`, e.g. one that
  Docker restarted after a reboot.
- **RPC nodes on 8555**: HAProxy holds 8545 on the VIP on both hosts, and Besu refuses to start
  when its port is in use on any address of the host, so rpc1/rpc2 can't use 8545 there.
- **`nopreempt`**: after a failover the VIPs stay on .136 when .135 returns (no second
  interruption). Move them back at a quiet time (section 5).

## 1. Prepare both hosts (.135 and .136)

```bash
dnf install -y keepalived haproxy
```

```bash
echo 'net.ipv4.ip_nonlocal_bind = 1' > /etc/sysctl.d/90-vip.conf && sysctl --system
```

The sysctl lets HAProxy bind the VIP on the host that doesn't hold it.

With SELinux (check with `getenforce`: `Enforcing` or `Permissive`):

```bash
setsebool -P haproxy_connect_any 1 && setsebool -P keepalived_connect_any 1
```

- `haproxy_connect_any`: HAProxy binds 8404/8545/9100 and connects to rpc1/rpc2 `:8555` and the
  coordinators `:9100`.
- `keepalived_connect_any`: keepalived's checks reach HAProxy's health page (`:8404`) and the
  proxy (`:30000`). Without it the HAProxy check fails and `.150` never comes up.

After copying the keepalived scripts (section 4), label them so they may run `docker compose`
(`semanage` is in `policycoreutils-python-utils`):

```bash
semanage fcontext -a -t keepalived_unconfined_script_exec_t '/etc/keepalived/(check-proxy|proxy-start|proxy-stop)\.sh'
```

```bash
restorecon -v /etc/keepalived/*.sh
```

If something is still blocked: `ausearch -m avc -ts recent`.

Firewall (on every host, see `firewall-layout.sh` for what it opens):

```bash
PROXY_CLIENTS="<application IPs>" CHAINLENS_USERS="<explorer users>" GRAFANA_USERS="<dashboard users>" REMIX_USERS="<developers>" ADMIN=<bastion IP> ./firewall-layout.sh 135
```

It writes firewalld rules and the same allow list for the ports Docker publishes, which bypass
firewalld: nftables table `inet besu_docker` (`/etc/besu-docker-firewall.rules`, applied at boot by
`besu-docker-firewall.service`). See [`docs/production-layout.md`](../docs/production-layout.md),
section 3.

Network interface name, for the keepalived files (the one with `192.168.68.13x`):

```bash
ip -br addr
```

## 2. Settings that must point at the VIPs

| Where | Setting |
|---|---|
| rpc1 and rpc2 `.env` | `BESU_HOST_ALLOWLIST` includes `192.168.68.150` (clients send `Host: 192.168.68.150`), then `./start.sh` |
| proxy `.env` on .135 and .136 | `BESU_IP` and `WEB3SIGNER_IP` = `192.168.68.150`, `MPC_ADMIN_URL=http://192.168.68.150:9100` (`proxy/.env.example`) |
| coord1 and coord2 `.env` | `MPC_BESU_RPC=http://192.168.68.150:8545`; `MPC_RELAY_URL` = each coordinator's **own** address |
| applications | the proxy at `http://192.168.68.151:30000` |

## 3. HAProxy (both hosts)

```bash
cp haproxy.cfg /etc/haproxy/haproxy.cfg
```

```bash
haproxy -c -f /etc/haproxy/haproxy.cfg && systemctl enable --now haproxy
```

## 4. keepalived (both hosts)

On .135 (`keepalived-136.conf` on .136):

```bash
cp keepalived-135.conf /etc/keepalived/keepalived.conf
```

```bash
cp check-proxy.sh proxy-start.sh proxy-stop.sh /etc/keepalived/ && chmod 700 /etc/keepalived/*.sh
```

Edit `/etc/keepalived/keepalived.conf`: `INTERFACE` and both `auth_pass` values (8 characters, the
same on both hosts). Edit `PROXY_DIR` in `proxy-start.sh` and `proxy-stop.sh` (the proxy
directory on that host). The proxy must already be configured and built on **both** hosts
(`docker compose build`), but **not started**: keepalived starts it on the host that takes `.151`.

Start keepalived on .135 first, then on .136:

```bash
systemctl enable --now keepalived
```

Check who holds the VIPs (both on .135 normally):

```bash
ip -br addr | grep -E '68\.15[01]/'
```

```bash
curl -s http://192.168.68.150:8545 -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

```bash
curl -s http://192.168.68.151:30000/status/senders
```

Logs: `journalctl -u keepalived` (VIP changes), `journalctl -t besu-ha` (proxy start/stop),
`journalctl -u haproxy`.

## 5. Operations

| Task | How |
|---|---|
| Move the VIPs back to .135 after a failover | at a quiet time, on .136: `systemctl restart keepalived` (it gives up the VIPs; .135 takes them and starts proxy1) |
| Planned maintenance of .135 | `systemctl stop keepalived` on .135 first (clean handover to .136), then the maintenance |
| Change `haproxy.cfg` | the same file on both hosts, `haproxy -c -f …`, `systemctl reload haproxy` |
| Proxy upgrade | build the new image on **both** hosts; on the active host `docker compose up -d proxy` (seconds of downtime) |
| Coordinator upgrade | coord2 first, then coord1 (HAProxy uses coord2 meanwhile) |

## 6. Failover tests

| Test | Do | Expect |
|---|---|---|
| RPC | on .135: stop rpc1 (`docker compose stop` in its directory) | requests on `.150:8545` keep working via rpc2 within ~6 s |
| Coordinator | stop coord1 | signing continues via coord2 at once (its pool is full) |
| Proxy | on .135: `docker compose stop proxy` | `.151` moves to .136 within ~10 s, proxy2 starts, `/status/senders` answers on `.151` |
| HAProxy | on .135: `systemctl stop haproxy` | `.150` moves to .136 within ~3–6 s |
| Whole host | power off .135 | both VIPs on .136, proxy2 running; chain continues (3 validators); a few seconds of errors |

Start everything again after each test and check Grafana before the next one.

## 7. Risks

- **Split brain:** if .135 and .136 can't exchange VRRP messages but both are alive (a firewall
  rule, a broken link), both take the VIPs and both run a proxy. No funds are lost (one
  transaction per nonce), but requests fail. Keep VRRP allowed in both directions, ideally over a
  second link between the two hosts, and check `ip -br addr` on both after network changes.
- **Same subnet only:** the VIPs move within 192.168.68.0/24. Hosts in other sites would need DNS
  or a routed load balancer instead.
- **Keep both hosts identical:** HAProxy file, proxy `.env` and image, coordinator settings.
