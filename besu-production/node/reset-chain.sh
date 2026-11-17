#!/usr/bin/env bash
# Delete this node's CHAIN DATA but KEEP its node key (/data/key), then start it on the
# genesis in network/. Use it when the operator generated a NEW genesis (a new chain) and Besu says:
#   "Supplied genesis block does not match chain data stored in /data"
# Run it on EVERY node of the network (validators first). All blocks, balances and contracts of the
# old chain are lost. Don't delete the volume instead: that also deletes the key, so the
# enode changes and no longer matches static-nodes.json / permissions_config.toml.
#   ./reset-chain.sh            (asks for confirmation)
#   ./reset-chain.sh --yes
set -Eeuo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "no .env here" >&2; exit 1; }
set -a; . ./.env; set +a
vol="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')_besu-data"
docker volume inspect "$vol" >/dev/null 2>&1 || { echo "volume $vol not found (run init.sh first)" >&2; exit 1; }
docker run --rm -v "$vol":/data --entrypoint test "$BESU_IMAGE" -s /data/key \
  || { echo "no node key in $vol - refusing to continue" >&2; exit 1; }

if [ "${1:-}" != "--yes" ]; then
  echo "This deletes ALL chain data of node ${NODE_NAME:-?} (volume $vol) and keeps only its key."
  read -r -p "Type the node name (${NODE_NAME:-}) to continue: " answer
  [ "$answer" = "${NODE_NAME:-}" ] || { echo "aborted"; exit 1; }
fi

docker compose down
docker run --rm -u 0 -v "$vol":/data --entrypoint bash "$BESU_IMAGE" -c \
  'find /data -mindepth 1 -maxdepth 1 ! -name key -exec rm -rf {} +; chown -R 1000:1000 /data; ls -A /data'
echo "chain data deleted, key kept"
./start.sh
