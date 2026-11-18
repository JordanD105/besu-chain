#!/bin/bash
# keepalived notify_master for the proxy VIP (/etc/keepalived/proxy-start.sh, chmod 700): this host
# now holds 192.168.68.151, so it runs the proxy. The proxy takes its nonces from the chain.
# PROXY_DIR: the proxy's directory on this host (same .env on .135 and .136).
PROXY_DIR=/opt/besu-chain/proxy
logger -t besu-ha "proxy VIP taken: starting the proxy"
cd "$PROXY_DIR" && /usr/bin/docker compose up -d proxy
