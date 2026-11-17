#!/usr/bin/env bash
# Start (or update) this node after checking the operator's network files.
#   network/ must contain genesis.json, static-nodes.json, permissions_config.toml and SHA256SUMS
#   (compare SHA256SUMS with the operator over a second channel).
set -Eeuo pipefail
cd "$(dirname "$0")"
for f in genesis.json static-nodes.json permissions_config.toml SHA256SUMS; do
  [ -f "network/$f" ] || { echo "missing network/$f (get it from the operator)" >&2; exit 1; }
done
(cd network && sha256sum -c --quiet SHA256SUMS) || { echo "network files do not match SHA256SUMS" >&2; exit 1; }
echo "network files OK: $(cat network/SHA256SUMS | sha256sum | cut -c1-16)"
docker compose up -d
