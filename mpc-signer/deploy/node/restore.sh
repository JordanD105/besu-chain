#!/usr/bin/env bash
# Restore THIS node's key share volume from a backup made by backup.sh (same node id!).
#   docker compose down            # stop the node first
#   ./restore.sh /path/to/mpc-nodeN-<time>.tgz
#   docker compose up -d           # needs the SAME MPC_NODE_PASSPHRASE as when the backup was made
# Refuses to overwrite a volume that already holds an identity.
set -Eeuo pipefail
cd "$(dirname "$0")"
archive="$(cd "$(dirname "${1:?backup archive}")" && pwd)/$(basename "$1")"
set -a; . ./.env; set +a
case "$(basename "$archive")" in mpc-node${MPC_NODE_ID}-*) ;; *) echo "archive is not for node ${MPC_NODE_ID}" >&2; exit 1 ;; esac
docker run --rm -u 0 --entrypoint tar -v "$(dirname "$archive")":/backup "$MPC_IMAGE" tzf "/backup/$(basename "$archive")" \
  | grep -q 'identity.seed' || { echo "archive has no identity.seed" >&2; exit 1; }
vol="$(docker compose config --format json | grep -o '"name": *"[^"]*mpc-data"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')"
docker volume create "$vol" >/dev/null
if docker run --rm -u 0 --entrypoint sh -v "$vol":/data "$MPC_IMAGE" -c 'test -e /data/identity.seed'; then
  echo "volume $vol already contains an identity; refusing to overwrite (remove it deliberately first)" >&2; exit 1
fi
docker run --rm -u 0 --entrypoint sh -v "$vol":/data -v "$(dirname "$archive")":/backup "$MPC_IMAGE" \
  -c "tar xzf /backup/$(basename "$archive") -C /data && chown -R 10001 /data && chmod 700 /data"
echo "restored $(basename "$archive") into $vol; start with: docker compose up -d"
