#!/usr/bin/env bash
# firewalld rules for the production layout (docs/production-layout.md). Run on each host as root:
#   CLIENTS="10.1.2.3 10.1.2.4" ADMIN=10.1.2.9 ./firewall-layout.sh 132      (132 133 134 135 136)
#   CLIENTS  applications that call the proxy (VIP .151:30000) and users of chainlens (.136:30100)
#   ADMIN    the bastion / operator host (SSH, Grafana, MPC admin API)
# Only the listed sources reach each port; everything else stays closed (firewalld default zone).
# Review with: firewall-cmd --list-all
set -Eeuo pipefail
host="${1:?usage: CLIENTS=... ADMIN=... ./firewall-layout.sh 132|133|134|135|136}"
NET=192.168.68
BESU_HOSTS="$NET.132 $NET.133 $NET.134 $NET.135"
MPC_HOSTS="$NET.132 $NET.134 $NET.135"      # mpc1, mpc2, mpc3
COORDS="$NET.132 $NET.133"                  # coord1, coord2 (also HAProxy, proxies)
MON=$NET.136
CLIENTS="${CLIENTS:-}"
ADMIN="${ADMIN:?set ADMIN to the bastion/operator IP}"

allow() { # allow <source> <port>/<proto>
  local src=$1 port=${2%/*} proto=${2#*/}
  firewall-cmd --permanent -q --add-rich-rule="rule family=\"ipv4\" source address=\"$src\" port port=\"$port\" protocol=\"$proto\" accept"
}
allow_all() { local port=$1; shift; for s in "$@"; do [ -n "$s" ] && allow "$s" "$port"; done; }

allow "$ADMIN" 22/tcp
allow "$MON" 9101/tcp                                            # node-exporter

case "$host" in
  132|133)
    peer=$([ "$host" = 132 ] && echo "$NET.133" || echo "$NET.132")
    firewall-cmd --permanent -q --add-rich-rule="rule family=\"ipv4\" source address=\"$peer\" protocol value=\"vrrp\" accept"
    for p in 30303/tcp 30303/udp 30304/tcp 30304/udp; do allow_all "$p" $BESU_HOSTS; done   # val + rpc p2p
    allow_all 9545/tcp "$MON"; allow_all 9546/tcp "$MON"                                   # Besu metrics
    allow_all 8545/tcp $COORDS "$MON" "$ADMIN"     # rpc node direct (HAProxy, chainlens -> rpc2, operator)
    allow_all 9100/tcp $COORDS $MPC_HOSTS "$MON" "$ADMIN"  # coordinator: HAProxy, MPC relay, metrics, admin
    allow_all 30000/tcp $CLIENTS "$MON" "$ADMIN"   # proxy (VIP .151 and this host)
    [ "$host" = 132 ] && allow_all 7000/tcp $COORDS                                        # mpc1
    ;;
  134|135)
    for p in 30303/tcp 30303/udp; do allow_all "$p" $BESU_HOSTS; done                     # validator p2p
    allow_all 9545/tcp "$MON"
    allow_all 7000/tcp $COORDS                                                             # mpc2 / mpc3
    ;;
  136)
    allow_all 3000/tcp "$ADMIN"                    # Grafana
    allow_all 30100/tcp $CLIENTS "$ADMIN"          # chainlens
    ;;
  *) echo "unknown host $host" >&2; exit 1 ;;
esac
firewall-cmd --reload
echo "firewall for .$host applied:"; firewall-cmd --list-rich-rules
