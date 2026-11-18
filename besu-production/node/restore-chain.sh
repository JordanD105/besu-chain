#!/usr/bin/env bash
# Restore a chain snapshot (from snapshot-chain.sh, possibly taken on ANOTHER node) into THIS
# node's data volume, keeping this node's own key. Used to rebuild the chain after a disaster
# (see docs/disaster-recovery.md), or to bring a new node up without syncing from block 0.
#   ./restore-chain.sh /backup/chain/besu-chain-rpc1-<time>-b<block>.tgz          (asks first)
#   ./restore-chain.sh --yes <archive>
# Checks: the .json next to the archive exists, the archive's sha256 matches it, and the snapshot
# was taken on the SAME chain (sha256 of network/genesis.json). The node key must already be in
# the volume: init.sh for a new node, restore-key.sh for a node whose key was backed up.
# Everything else in the volume (old chain data) is replaced.
set -Eeuo pipefail
cd "$(dirname "$0")"
yes=0
if [ "${1:-}" = "--yes" ]; then yes=1; shift; fi
archive="$(cd "$(dirname "${1:?usage: ./restore-chain.sh [--yes] /path/to/besu-chain-...tgz}")" && pwd)/$(basename "$1")"
meta="${archive%.tgz}.json"
[ -f .env ] || { echo "no .env here" >&2; exit 1; }
set -a; . ./.env; set +a
vol="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')_besu-data"

[ -f "$archive" ] || { echo "archive not found: $archive" >&2; exit 1; }
[ -f "$meta" ] || { echo "metadata not found: $meta" >&2; exit 1; }
[ -f network/genesis.json ] || { echo "network/genesis.json missing (copy the operator's network files first)" >&2; exit 1; }
field() { sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\).*/\1/p" "$meta" | head -n1; }
[ "$(sha256sum "$archive" | cut -d' ' -f1)" = "$(field archiveSha256)" ] \
  || { echo "archive checksum does not match $meta: corrupted or incomplete copy" >&2; exit 1; }
[ "$(sha256sum network/genesis.json | cut -d' ' -f1)" = "$(field genesisSha256)" ] \
  || { echo "this snapshot is from a DIFFERENT chain (genesis.json differs): refusing" >&2; exit 1; }
docker volume inspect "$vol" >/dev/null 2>&1 \
  && docker run --rm -v "$vol":/data --entrypoint test "$BESU_IMAGE" -s /data/key \
  || { echo "no node key in volume $vol: run init.sh (new node) or restore-key.sh (backed-up key) first" >&2; exit 1; }

echo "snapshot: node $(field node), block $(field block), taken $(field createdAt)"
if [ "$yes" != 1 ]; then
  echo "This REPLACES all chain data of node ${NODE_NAME} (volume $vol); its key is kept."
  read -r -p "Type the node name (${NODE_NAME}) to continue: " answer
  [ "$answer" = "${NODE_NAME}" ] || { echo "aborted"; exit 1; }
fi

docker compose down >/dev/null 2>&1 || true
docker run --rm -u 0 --entrypoint bash -v "$vol":/data "$BESU_IMAGE" -c \
  'find /data -mindepth 1 -maxdepth 1 ! -name key -exec rm -rf {} +'
gzip -dc "$archive" | docker run --rm -i -u 0 --entrypoint bash -v "$vol":/data "$BESU_IMAGE" -c \
  'tar xf - -C /data && chown -R 1000:1000 /data'
echo "chain data restored (block $(field block)); starting the node"
./start.sh
