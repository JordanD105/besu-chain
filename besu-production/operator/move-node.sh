#!/usr/bin/env bash
# A node keeps its key but moves to another host or port (new IP:port in its enode): update ONLY
# static-nodes.json, permissions_config.toml and SHA256SUMS. genesis.json never changes.
#   ./move-node.sh network/ validator2.json 192.168.68.136:30303
#   (the .json is the one init.sh wrote for that node; only its public key is used)
# Then: copy the 4 files to EVERY node, restart the other nodes one at a time
# (./start.sh && docker compose restart), stop the node on its old host, and start it on the new
# host with its key (restore-key.sh) and the new P2P_HOST / P2P_PORT in its .env.
# docs/operations/disaster-recovery.md, 6.1 "New IP".
set -Eeuo pipefail
dir="$(cd "${1:?network dir}" && pwd)"; f="${2:?node json}"; new="${3:?new IP:port}"
[[ "$new" =~ ^[0-9.]+:[0-9]+$ ]] || { echo "new address must be IP:port, e.g. 192.168.68.136:30303" >&2; exit 1; }
pub=$(sed -nE 's/.*"enode": *"enode:\/\/([0-9a-f]{128})@.*/\1/p' "$f")
[ -n "$pub" ] || { echo "$f: no enode" >&2; exit 1; }
(cd "$dir" && sha256sum -c --quiet SHA256SUMS) || { echo "network files do not match SHA256SUMS" >&2; exit 1; }
old=$(grep -o "enode://$pub@[^\"]*" "$dir/static-nodes.json" | head -n1)
[ -n "$old" ] || { echo "this node is not in $dir/static-nodes.json" >&2; exit 1; }
if grep -q "@$new\"" "$dir/static-nodes.json"; then
  echo "another node already uses $new" >&2; exit 1
fi
for file in static-nodes.json permissions_config.toml; do
  sed -i "s|enode://$pub@[^\"]*|enode://$pub@$new|" "$dir/$file"
done
(cd "$dir" && sha256sum genesis.json static-nodes.json permissions_config.toml > SHA256SUMS)
echo "moved ${old#*@} -> $new"; cat "$dir/SHA256SUMS"
