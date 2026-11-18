#!/usr/bin/env bash
# Back up THIS node's sealed key share volume (identity, aux info, key shares).
# The files are sealed (Argon2id + XChaCha20-Poly1305) and useless without MPC_NODE_PASSPHRASE:
# store the archive and the passphrase SEPARATELY, under this node's team only, and never put two
# nodes' backups in the same place (two shares = can sign).
#   ./backup.sh /path/to/backup-dir
# Uses the MPC signer image itself (no extra image to pull). Safe while the node is running.
set -Eeuo pipefail
cd "$(dirname "$0")"
out="$(cd "${1:?backup directory}" 2>/dev/null && pwd || { mkdir -p "$1" && cd "$1" && pwd; })"
set -a; . ./.env; set +a
. ./backup-metrics.sh
trap 'rc=$?; if [ $rc -ne 0 ]; then backup_metric mpc-share "mpc-node${MPC_NODE_ID}" failure; echo "backup FAILED" >&2; fi' EXIT
vol="$(docker compose config --format json | grep -o '"name": *"[^"]*mpc-data"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')"
[ -n "$vol" ] && docker volume inspect "$vol" >/dev/null 2>&1 || { echo "volume $vol not found" >&2; exit 1; }
name="mpc-node${MPC_NODE_ID}-$(date -u +%Y%m%dT%H%M%SZ).tgz"
docker run --rm -u 0 --entrypoint tar -v "$vol":/data:ro -v "$out":/backup "$MPC_IMAGE" czf "/backup/$name" -C /data .
docker run --rm -u 0 --entrypoint tar -v "$out":/backup "$MPC_IMAGE" tzf "/backup/$name" | grep -c 'identity.seed' >/dev/null \
  || { echo "backup $name does not contain identity.seed" >&2; exit 1; }
backup_metric mpc-share "mpc-node${MPC_NODE_ID}" success "$(stat -c %s "$out/$name")"
echo "backup: $out/$name"
