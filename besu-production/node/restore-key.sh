#!/usr/bin/env bash
# Put a backed-up node key (from backup-key.sh, DECRYPTED) into THIS node's data volume, on a new
# or rebuilt host. The node keeps its identity (enode, validator address), so the network files
# stay valid and a validator stays in the validator set. Then run start.sh (it syncs from the
# other nodes), or restore-chain.sh first when every node was lost.
#   ./restore-key.sh /secure/validator1.key
# Refuses to replace a DIFFERENT key already in the volume.
set -Eeuo pipefail
cd "$(dirname "$0")"
keyfile="$(cd "$(dirname "${1:?usage: ./restore-key.sh /path/to/<node>.key}")" && pwd)/$(basename "$1")"
[ -f .env ] || { echo "create .env first (same values as the lost node: NODE_NAME, P2P_HOST, ports)" >&2; exit 1; }
set -a; . ./.env; set +a
grep -Eq '^(0x)?[0-9a-fA-F]{64}$' "$keyfile" || { echo "$keyfile is not a node key (64 hex chars)" >&2; exit 1; }
vol="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')_besu-data"
project="${vol%_besu-data}"
docker volume inspect "$vol" >/dev/null 2>&1 || docker volume create \
  --label com.docker.compose.project="$project" --label com.docker.compose.volume=besu-data "$vol" >/dev/null

existing=$(docker run --rm -u 0 -v "$vol":/data --entrypoint bash "$BESU_IMAGE" -c 'cat /data/key 2>/dev/null || true')
if [ -n "$existing" ] && [ "$(echo "$existing" | tr -d '\n' | sed 's/^0x//')" != "$(tr -d '\n' < "$keyfile" | sed 's/^0x//')" ]; then
  echo "volume $vol already holds a DIFFERENT key: refusing (remove the volume deliberately if it is a leftover)" >&2
  exit 1
fi

docker run --rm -i -u 0 -v "$vol":/data --entrypoint bash "$BESU_IMAGE" -c \
  'umask 077; k=$(tr -d "\n" | sed "s/^0x//"); printf "0x%s" "$k" > /data/key; chown -R 1000:1000 /data' < "$keyfile"
pub=$(docker run --rm -v "$vol":/data "$BESU_IMAGE" --data-path=/data public-key export 2>/dev/null | grep -Eo '0x[0-9a-f]{128}' | tail -n1)
addr=$(docker run --rm -v "$vol":/data "$BESU_IMAGE" --data-path=/data public-key export-address 2>/dev/null | grep -Eo '0x[0-9a-f]{40}' | tail -n1)
echo "key restored for ${NODE_NAME}: address $addr"
echo "enode: enode://${pub#0x}@${P2P_HOST}:${P2P_PORT:-30303}"
if [ -f network/static-nodes.json ]; then
  if grep -q "${pub#0x}@${P2P_HOST}:${P2P_PORT:-30303}" network/static-nodes.json; then
    echo "OK: this enode is in network/static-nodes.json"
  else
    echo "WARNING: this enode (key + P2P_HOST:P2P_PORT) is NOT in network/static-nodes.json: wrong key, or this host's IP/port differs from the lost node's" >&2
  fi
fi
