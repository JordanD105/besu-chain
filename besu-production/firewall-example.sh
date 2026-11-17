#!/usr/bin/env bash
# Example ufw rules for a production Besu host (on top of the private/WireGuard network).
#   ROLE=validator BESU_NODES="10.10.1.11 10.10.2.11 ..." PROMETHEUS=10.10.0.40 BASTION=10.10.1.2
#   ROLE=rpc       BESU_NODES="..." PROMETHEUS=... BASTION=... RPC_CLIENTS="10.10.0.30 10.10.0.5"
# Several nodes on this host (docker-compose.host.yml): list every node's ports, e.g. for rpc1+val1+val2
#   ROLE=rpc P2P_PORTS="30303 30304 30305" METRICS_PORTS="9545 9546 9547" RPC_PORTS="8545 8546" ...
#   (RPC_PORTS = the RPC node's RPC_PORT + WS_PORT; validators' RPC stays on 127.0.0.1)
set -Eeuo pipefail
ufw default deny incoming
ufw default allow outgoing
ufw allow from "${BASTION:?}" to any port 22 proto tcp
for n in ${BESU_NODES:?all validator + RPC node IPs}; do
  for p in ${P2P_PORTS:-30303}; do
    ufw allow from "$n" to any port "$p" proto tcp
    ufw allow from "$n" to any port "$p" proto udp
  done
done
for p in ${METRICS_PORTS:-9545}; do ufw allow from "${PROMETHEUS:?}" to any port "$p" proto tcp; done
if [ "${ROLE:?validator|rpc}" = rpc ]; then
  for c in ${RPC_CLIENTS:?proxy, MPC coordinator, explorer IPs}; do
    for p in ${RPC_PORTS:-8545 8546}; do ufw allow from "$c" to any port "$p" proto tcp; done
  done
fi
# validators: JSON-RPC is published on 127.0.0.1 only (operator via SSH) - nothing to open
ufw --force enable
ufw status verbose
