#!/usr/bin/env bash
# Copy THIS node's private node key out of the data volume, for this team's vault ONLY.
# A validator's key is its QBFT identity: if it is lost, the validator must be replaced by a vote.
# The file is SECRET: encrypt it (e.g. gpg --symmetric) and delete the plain copy.
#   ./backup-key.sh /secure/dir
set -Eeuo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
. ./backup-metrics.sh
out="${1:?directory}"; mkdir -p "$out"; chmod 700 "$out"
vol="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')_besu-data"
docker run --rm -u 0 -v "$vol":/data:ro -v "$(cd "$out" && pwd)":/out --entrypoint cp "$BESU_IMAGE" /data/key "/out/${NODE_NAME}.key"
chmod 600 "$out/${NODE_NAME}.key"
kind=node-key; [ "$BESU_ROLE" = validator ] && kind=validator-key
backup_metric "$kind" "$NODE_NAME" success "$(stat -c %s "$out/${NODE_NAME}.key")"
echo "node key copied to $out/${NODE_NAME}.key - encrypt it and store it in this team's vault"
echo "(recorded for monitoring; restore with ./restore-key.sh)"
