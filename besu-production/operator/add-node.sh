#!/usr/bin/env bash
# Add a node (new validator or RPC node) to a RUNNING network: updates ONLY static-nodes.json,
# permissions_config.toml and SHA256SUMS. genesis.json never changes on a live chain.
#   ./add-node.sh network/ validator5.json
# Then: copy the 4 files to EVERY node (incl. the new one), restart nodes one at a time
# (./start.sh), start the new node; for a validator, vote it in with qbft.sh (see README).
set -Eeuo pipefail
dir="$(cd "${1:?network dir}" && pwd)"; f="${2:?node json}"
enode=$(sed -E 's/.*"enode": *"([^"]*)".*/\1/' "$f")
[[ "$enode" =~ ^enode://[0-9a-f]{128}@[^:]+:[0-9]+$ ]] || { echo "$f: bad enode" >&2; exit 1; }
grep -q "${enode%@*}" "$dir/static-nodes.json" && { echo "node already in the network files" >&2; exit 1; }
(cd "$dir" && sha256sum -c --quiet SHA256SUMS) || { echo "network files do not match SHA256SUMS" >&2; exit 1; }
sed -i '$ d' "$dir/static-nodes.json"; sed -i '$ s/"$/",/' "$dir/static-nodes.json"
printf '  "%s"\n]\n' "$enode" >> "$dir/static-nodes.json"
sed -i '$ d' "$dir/permissions_config.toml"; sed -i '$ s/"$/",/' "$dir/permissions_config.toml"
printf '  "%s"\n]\n' "$enode" >> "$dir/permissions_config.toml"
(cd "$dir" && sha256sum genesis.json static-nodes.json permissions_config.toml > SHA256SUMS)
echo "added $(sed -E 's/.*"name": *"([^"]*)".*/\1/' "$f"):"; cat "$dir/SHA256SUMS"
