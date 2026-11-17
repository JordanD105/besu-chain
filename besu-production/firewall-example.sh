#!/usr/bin/env bash
# Example ufw rules for a production Besu host (on top of the private/WireGuard network).
#   ROLE=validator BESU_NODES="10.10.1.11 10.10.2.11 ..." PROMETHEUS=10.10.0.40 BASTION=10.10.1.2
#   ROLE=rpc       BESU_NODES="..." PROMETHEUS=... BASTION=... RPC_CLIENTS="10.10.0.30 10.10.0.5"
set -Eeuo pipefail
ufw default deny incoming
ufw default allow outgoing
ufw allow from "${BASTION:?}" to any port 22 proto tcp
for n in ${BESU_NODES:?all validator + RPC node IPs}; do
  ufw allow from "$n" to any port 30303 proto tcp
  ufw allow from "$n" to any port 30303 proto udp
done
ufw allow from "${PROMETHEUS:?}" to any port 9545 proto tcp
if [ "${ROLE:?validator|rpc}" = rpc ]; then
  for c in ${RPC_CLIENTS:?proxy, MPC coordinator, explorer IPs}; do
    ufw allow from "$c" to any port 8545 proto tcp
    ufw allow from "$c" to any port 8546 proto tcp
  done
fi
# validators: JSON-RPC is published on 127.0.0.1 only (operator via SSH) - nothing to open
ufw --force enable
ufw status verbose
