#!/bin/bash
# keepalived notify_backup / notify_fault for the proxy VIP (/etc/keepalived/proxy-stop.sh,
# chmod 700): this host gave up 192.168.68.151, so its proxy must stop (only one proxy may send
# for a sender at a time).
PROXY_DIR=/opt/besu-chain/proxy
logger -t besu-ha "proxy VIP released: stopping the proxy"
cd "$PROXY_DIR" && /usr/bin/docker compose stop proxy
