# ha: HAProxy + keepalived for the production layout

Two floating IPs on **192.168.68.132** (normally) and **192.168.68.133** (after a failover), so that
losing .132 doesn't stop payments. Layout and settings: [`../docs/production-layout.md`](../docs/production-layout.md).

| VIP | What | Failover |
|---|---|---|
| `192.168.68.150` | HAProxy: `:8545` → rpc1 (rpc2 backup), `:9100` → coord1 (coord2 backup) | HAProxy switches backends in ~6 s; keepalived moves the VIP if HAProxy itself fails |
| `192.168.68.151` | the proxy, `:30000` | keepalived moves the VIP and starts proxy2 / stops proxy1 |

| File | Goes to (on .132 and .133) |
|---|---|
| `haproxy.cfg` | `/etc/haproxy/haproxy.cfg` (identical) |
| `keepalived-132.conf` / `keepalived-133.conf` | `/etc/keepalived/keepalived.conf` |
| `check-proxy.sh`, `proxy-start.sh`, `proxy-stop.sh` | `/etc/keepalived/` (chmod 700) |
| `firewall-layout.sh` | run once on **every** host (.132–.136) |

Why this design:
- **One backend at a time** (rpc2 and coord2 are `backup`): the proxy reads nonces from the same
  RPC node the coordinator sends to, and only one presignature pool is consumed. coord2 runs all
  the time with its pool full, and re-reads the key list from the MPC nodes, so it signs for
  every account the moment it takes over.
- **Only one proxy at a time**: the proxy counts nonces per sender in memory. keepalived starts
  the proxy on the host that takes `.151` and stops it on the host that gives it up.
- **`nopreempt`**: after a failover the VIPs stay on .133 when .132 returns (no second
  interruption). Move them back at a quiet time (section 5).

## 1. Prepare both hosts (.132 and .133)

```bash
dnf install -y keepalived haproxy
```

```bash
echo 'net.ipv4.ip_nonlocal_bind = 1' > /etc/sysctl.d/90-vip.conf && sysctl --system
```

```bash
setsebool -P haproxy_connect_any 1
```

The first lets HAProxy bind the VIP on the host that doesn't hold it; the second lets HAProxy
(SELinux) connect to ports 8545 and 9100.

Firewall (on every host, see `firewall-layout.sh` for what it opens):

```bash
CLIENTS="<application IPs>" ADMIN=<bastion IP> ./firewall-layout.sh 132
```

Network interface name, for the keepalived files (the one with `192.168.68.13x`):

```bash
ip -br addr
```

## 2. Settings that must point at the VIPs

| Where | Setting |
|---|---|
| rpc1 and rpc2 `.env` | `BESU_HOST_ALLOWLIST` includes `192.168.68.150` (clients send `Host: 192.168.68.150`), then `./start.sh` |
| proxy `.env` on .132 and .133 | `BESU_IP` and `WEB3SIGNER_IP` = `192.168.68.150`, `MPC_ADMIN_URL=http://192.168.68.150:9100` (`proxy/.env.example`) |
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

On .132 (`keepalived-133.conf` on .133):

```bash
cp keepalived-132.conf /etc/keepalived/keepalived.conf
```

```bash
cp check-proxy.sh proxy-start.sh proxy-stop.sh /etc/keepalived/ && chmod 700 /etc/keepalived/*.sh
```

Edit `/etc/keepalived/keepalived.conf`: `INTERFACE` and both `auth_pass` values (8 characters, the
same on both hosts). Edit `PROXY_DIR` in `proxy-start.sh` and `proxy-stop.sh` (the proxy
directory on that host). The proxy on .133 must be built and configured like the one on .132
(`docker compose build`), but **not started**.

Start keepalived on .132 first, then on .133:

```bash
systemctl enable --now keepalived
```

Check who holds the VIPs (both on .132 normally):

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
| Move the VIPs back to .132 after a failover | at a quiet time, on .133: `systemctl restart keepalived` (it gives up the VIPs; .132 takes them and starts proxy1) |
| Planned maintenance of .132 | `systemctl stop keepalived` on .132 first (clean handover to .133), then the maintenance |
| Change `haproxy.cfg` | the same file on both hosts, `haproxy -c -f …`, `systemctl reload haproxy` |
| Proxy upgrade | build the new image on **both** hosts; on the active host `docker compose up -d proxy` (seconds of downtime) |
| Coordinator upgrade | coord2 first, then coord1 (HAProxy uses coord2 meanwhile) |

## 6. Failover tests

| Test | Do | Expect |
|---|---|---|
| RPC | on .132: stop rpc1 (`docker compose stop` in its directory) | requests on `.150:8545` keep working via rpc2 within ~6 s |
| Coordinator | stop coord1 | signing continues via coord2 at once (its pool is full) |
| Proxy | on .132: `docker compose stop proxy` | `.151` moves to .133 within ~10 s, proxy2 starts, `/status/senders` answers on `.151` |
| HAProxy | on .132: `systemctl stop haproxy` | `.150` moves to .133 within ~3–6 s |
| Whole host | power off .132 | both VIPs on .133, proxy2 running; chain continues (3 validators); a few seconds of errors |

Start everything again after each test and check Grafana before the next one.

## 7. Risks

- **Split brain:** if .132 and .133 can't exchange VRRP messages but both are alive (a firewall
  rule, a broken link), both take the VIPs and both run a proxy. No funds are lost (one
  transaction per nonce), but requests fail. Keep VRRP allowed in both directions, ideally over a
  second link between the two hosts, and check `ip -br addr` on both after network changes.
- **Same subnet only:** the VIPs move within 192.168.68.0/24. Hosts in other sites would need DNS
  or a routed load balancer instead.
- **Keep both hosts identical:** HAProxy file, proxy `.env` and image, coordinator settings.
