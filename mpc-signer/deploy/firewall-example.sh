#!/usr/bin/env bash
# Example host firewall (ufw) for the MPC signer, on top of the private/WireGuard network.
# Adjust the addresses; run the matching block on each host. Default deny inbound.
#   ROLE=node        COORDINATORS="10.10.0.5 10.10.0.6"
#   ROLE=coordinator NODES="10.10.0.10 10.10.1.10 10.10.2.10" CLIENTS="10.10.0.30" OPERATOR=10.10.0.2
#                    PROMETHEUS=10.10.0.40   (optional: monitoring scrapes /metrics on 9100)
#   NODE_EXPORTER_FROM=10.10.0.40 on any role: host metrics (monitoring/node-exporter, port 9101)
set -Eeuo pipefail
ufw default deny incoming
ufw default allow outgoing
ufw allow from "${ADMIN_NET:-10.10.0.2}" to any port 22 proto tcp      # SSH from this team's bastion
case "${ROLE:?node|coordinator}" in
  node)
    for c in ${COORDINATORS:?}; do ufw allow from "$c" to any port 7000 proto tcp; done ;;
  coordinator)
    for n in ${NODES:?}; do ufw allow from "$n" to any port 9100 proto tcp; done        # relay (WebSocket)
    for c in ${CLIENTS:?} ${OPERATOR:?} ${PROMETHEUS:-}; do ufw allow from "$c" to any port 9100 proto tcp; done ;;
esac
[ -z "${NODE_EXPORTER_FROM:-}" ] || ufw allow from "$NODE_EXPORTER_FROM" to any port 9101 proto tcp
ufw --force enable
ufw status verbose
