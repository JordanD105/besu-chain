#!/usr/bin/env bash
# Initialise THIS MPC node (run once, on the node host, by this node's team).
#   cp .env.example .env && edit MPC_IMAGE, MPC_NODE_ID, MPC_BIND_IP, MPC_NODE_TOKEN
#   ./init.sh            -> generates the passphrase, creates the identity, writes node<ID>.json
# Send node<ID>.json (PUBLIC keys only) to the operator who builds cluster.json.
set -Eeuo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "create .env from .env.example first"; exit 1; }
chmod 600 .env
set -a; . ./.env; set +a
: "${MPC_NODE_ID:?}" "${MPC_BIND_IP:?}" "${MPC_IMAGE:?}"
if [ -z "${MPC_NODE_PASSPHRASE:-}" ]; then
  pass=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  sed -i "s/^MPC_NODE_PASSPHRASE=.*/MPC_NODE_PASSPHRASE=$pass/" .env
  echo "generated MPC_NODE_PASSPHRASE in .env: store a copy in this team's password vault NOW"
  export MPC_NODE_PASSPHRASE=$pass
fi
[ -f cluster.json ] || echo '{}' > cluster.json   # placeholder for the bind mount
pub=$(docker compose run --rm --no-deps -T mpc-node mpc-node init | tail -n1)
sign_pk=$(printf '%s' "$pub" | sed -E 's/.*"sign_pk":"([0-9a-f]+)".*/\1/')
kx_pk=$(printf '%s' "$pub" | sed -E 's/.*"kx_pk":"([0-9a-f]+)".*/\1/')
cat > "node${MPC_NODE_ID}.json" <<JSON
{"id": ${MPC_NODE_ID}, "url": "http://${MPC_BIND_IP}:${MPC_PORT:-7000}", "sign_pk": "${sign_pk}", "kx_pk": "${kx_pk}"}
JSON
echo "wrote node${MPC_NODE_ID}.json (public keys only):"; cat "node${MPC_NODE_ID}.json"
