#!/usr/bin/env bash
# firewalld rules for the production layout (docs/production-layout.md). Run on each host as root:
#   CLIENTS="10.1.2.3 10.1.2.4" ADMIN=10.1.2.9 ./firewall-layout.sh 135      (135 136 137 138 139)
#   CLIENTS  applications that call the proxy (VIP .151:30000) and users of chainlens (.139:30100)
#   ADMIN    the bastion / operator host (SSH, Grafana, MPC admin API)
# Only the listed sources reach each port; everything else stays closed (firewalld default zone).
# Review with: firewall-cmd --list-all
set -Eeuo pipefail
host="${1:?usage: CLIENTS=... ADMIN=... ./firewall-layout.sh 135|136|137|138|139}"
NET=192.168.68
BESU_HOSTS="$NET.135 $NET.136 $NET.137 $NET.138"
MPC_HOSTS="$NET.135 $NET.137 $NET.138"      # mpc1, mpc2, mpc3
COORDS="$NET.135 $NET.136"                  # coord1, coord2 (also HAProxy, proxies)
MON=$NET.139
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
  135|136)
    peer=$([ "$host" = 135 ] && echo "$NET.136" || echo "$NET.135")
    firewall-cmd --permanent -q --add-rich-rule="rule family=\"ipv4\" source address=\"$peer\" protocol value=\"vrrp\" accept"
    for p in 30303/tcp 30303/udp 30304/tcp 30304/udp; do allow_all "$p" $BESU_HOSTS; done   # val + rpc p2p
    allow_all 9545/tcp "$MON"; allow_all 9546/tcp "$MON"                                   # Besu metrics
    allow_all 8545/tcp $COORDS "$MON" "$ADMIN"     # rpc node direct (HAProxy, chainlens -> rpc2, operator)
    allow_all 9100/tcp $COORDS $MPC_HOSTS "$MON" "$ADMIN"  # coordinator: HAProxy, MPC relay, metrics, admin
    allow_all 30000/tcp $CLIENTS "$MON" "$ADMIN"   # proxy (VIP .151 and this host)
    [ "$host" = 135 ] && allow_all 7000/tcp $COORDS                                        # mpc1
    ;;
  137|138)
    for p in 30303/tcp 30303/udp; do allow_all "$p" $BESU_HOSTS; done                     # validator p2p
    allow_all 9545/tcp "$MON"
    allow_all 7000/tcp $COORDS                                                             # mpc2 / mpc3
    ;;
  139)
    allow_all 3000/tcp "$ADMIN"                    # Grafana
    allow_all 30100/tcp $CLIENTS "$ADMIN"          # chainlens
    ;;
  *) echo "unknown host $host" >&2; exit 1 ;;
esac
firewall-cmd --reload
echo "firewall for .$host applied:"; firewall-cmd --list-rich-rules
