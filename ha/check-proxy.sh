#!/bin/bash
# keepalived check for the proxy VIP (/etc/keepalived/check-proxy.sh, chmod 700, on .135 and .136).
# On the host HOLDING 192.168.68.151 the proxy must answer; on the other host its proxy is
# supposed to be stopped, so the check passes there.
VIP=192.168.68.151
ip -br addr | grep -q "${VIP//./\\.}/" || exit 0
/usr/bin/curl -sf -m 3 -o /dev/null http://127.0.0.1:30000/status/senders
