#!/bin/bash
# keepalived check for the proxy VIP (/etc/keepalived/check-proxy.sh, chmod 700, on .135 and .136),
# every 3 seconds.
# - On the host HOLDING 192.168.68.151 the proxy must answer.
# - On the other host no proxy may run: only one proxy may send for a sender at a time. Docker's
#   restart policy brings a proxy back after a reboot even on the standby host (keepalived's
#   notify_backup can run before Docker restores its containers), so stop it here. The check still
#   passes on that host.
VIP=192.168.68.151
PROXY_DIR=/opt/besu-chain/proxy
if ! ip -o addr | grep -q " ${VIP//./\\.}/"; then
  if [ -n "$(/usr/bin/docker ps -q --filter label=com.docker.compose.project=proxy --filter label=com.docker.compose.service=proxy)" ]; then
    logger -t besu-ha "proxy running without the proxy VIP: stopping it"
    cd "$PROXY_DIR" && /usr/bin/docker compose stop proxy >/dev/null 2>&1
  fi
  exit 0
fi
/usr/bin/curl -sf -m 3 -o /dev/null http://127.0.0.1:30000/status/senders
