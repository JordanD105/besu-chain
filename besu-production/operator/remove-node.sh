#!/usr/bin/env bash
# Remove a node from a RUNNING network: deletes its enode from static-nodes.json and
# permissions_config.toml and rewrites SHA256SUMS. genesis.json never changes.
#   ./remove-node.sh network/ val5.json      (the .json init.sh wrote for that node)
# A validator must be voted out FIRST (ansible/qbft-vote.yml ... vote=remove, or qbft.sh propose
# <address> false on more than half of the validators). Then copy the 4 files to every remaining
# node and restart them one at a time (ansible: 05-besu.yml). docs/operations/adding-nodes.md
set -Eeuo pipefail
dir="$(cd "${1:?network dir}" && pwd)"; f="${2:?node json}"
pub=$(sed -nE 's/.*"enode": *"enode:\/\/([0-9a-f]{128})@.*/\1/p' "$f")
[ -n "$pub" ] || { echo "$f: no enode" >&2; exit 1; }
(cd "$dir" && sha256sum -c --quiet SHA256SUMS) || { echo "network files do not match SHA256SUMS" >&2; exit 1; }
grep -q "enode://$pub@" "$dir/static-nodes.json" || { echo "this node is not in $dir/static-nodes.json" >&2; exit 1; }
for file in static-nodes.json permissions_config.toml; do
  # drop the node's line, then remove a trailing comma left before the closing ]
  sed -i "/enode:\/\/$pub@/d" "$dir/$file"
  python3 - "$dir/$file" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
open(p, 'w').write(re.sub(r',(\s*\])', r'\1', s))
PY
done
(cd "$dir" && sha256sum genesis.json static-nodes.json permissions_config.toml > SHA256SUMS)
echo "removed $(sed -E 's/.*"name": *"([^"]*)".*/\1/' "$f"):"; cat "$dir/SHA256SUMS"
