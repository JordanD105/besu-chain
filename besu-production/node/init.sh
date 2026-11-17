#!/usr/bin/env bash
# Create THIS node's key (inside the data volume, never leaves the host) and write
# <NODE_NAME>.json with its PUBLIC enode / address for the operator.
set -Eeuo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "create .env from .env.example first"; exit 1; }
chmod 600 .env
set -a; . ./.env; set +a
: "${BESU_IMAGE:?}" "${BESU_ROLE:?}" "${NODE_NAME:?}" "${P2P_HOST:?}"
case "$BESU_ROLE" in validator|rpc) ;; *) echo "BESU_ROLE must be validator or rpc"; exit 1 ;; esac
vol="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')_besu-data"
project="${vol%_besu-data}"
docker volume inspect "$vol" >/dev/null 2>&1 || docker volume create \
  --label com.docker.compose.project="$project" --label com.docker.compose.volume=besu-data "$vol" >/dev/null
# Generate the node key inside the data volume (32 random bytes from the kernel CSPRNG, Besu's
# key file format), once. It never leaves this host. The volume belongs to the besu user (1000).
docker run --rm -u 0 -v "$vol":/data --entrypoint bash "$BESU_IMAGE" -c \
  'umask 077; [ -s /data/key ] || printf "0x%s" "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n")" > /data/key; chown -R 1000:1000 /data'
pub=$(docker run --rm -v "$vol":/data "$BESU_IMAGE" --data-path=/data public-key export 2>/dev/null \
        | grep -Eo '0x[0-9a-f]{128}' | tail -n1)
addr=$(docker run --rm -v "$vol":/data "$BESU_IMAGE" --data-path=/data public-key export-address 2>/dev/null \
        | grep -Eo '0x[0-9a-f]{40}' | tail -n1)
[ -n "$pub" ] && [ -n "$addr" ] || { echo "could not read the node key" >&2; exit 1; }
cat > "${NODE_NAME}.json" <<JSON
{"name": "${NODE_NAME}", "role": "${BESU_ROLE}", "address": "${addr}", "enode": "enode://${pub#0x}@${P2P_HOST}:${P2P_PORT:-30303}"}
JSON
mkdir -p network
echo "wrote ${NODE_NAME}.json (public only) - send it to the operator:"; cat "${NODE_NAME}.json"
