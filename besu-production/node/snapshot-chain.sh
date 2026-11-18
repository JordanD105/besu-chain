#!/usr/bin/env bash
# Snapshot of THIS node's chain data (blocks + state), to rebuild the chain after a disaster that
# takes every node (whole site, ransomware, ...). Run it on ONE node, e.g. daily from cron.
#   ./snapshot-chain.sh /backup/chain
# The node is STOPPED while its data is archived (a few minutes for a large chain), then started.
# Which node: a node your applications do not depend on, e.g. a validator (the chain continues with
# the others): val3 on .134 in the production layout. NOT the RPC node serving the proxy/coordinators.
# Before stopping, it checks that this node sees ALL the other nodes, so a validator is never
# stopped while another node is already down (that could halt the chain).
#
# Output: besu-chain-<NODE_NAME>-<UTC time>-b<block>.tgz + .json (block, chain id, genesis.json
# sha256, archive sha256). The node key is NOT included: a snapshot can be restored onto any node
# (restore-chain.sh keeps that node's own key). It holds no secrets, but it is your chain's data:
# keep a copy OFF-SITE.
#   KEEP=7                    snapshots kept in the directory (older ones deleted)
#   COPY_TO=user@host:/path   also copy each snapshot there with rsync (off-site); failure = failed
#   FORCE=1                   skip the "all peers connected" check
#   BACKUP_METRICS_DIR=...    node-exporter textfile dir (default /var/lib/node_exporter/textfile)
set -Eeuo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "no .env here" >&2; exit 1; }
set -a; . ./.env; set +a
. ./backup-metrics.sh
out="${1:?usage: ./snapshot-chain.sh /backup/dir}"
mkdir -p "$out"; out="$(cd "$out" && pwd)"
KEEP="${KEEP:-7}"
vol="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')_besu-data"
rpc="http://${RPC_BIND_IP:-127.0.0.1}:${RPC_PORT:-8545}"
call() { curl -s -m 10 "$rpc" -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" || true; }
result() { sed -n 's/.*"result":"\{0,1\}\([^",}]*\).*/\1/p'; }

stopped=0
fail() {
  echo "snapshot FAILED: $*" >&2
  backup_metric chain "$NODE_NAME" failure
  if [ "$stopped" = 1 ]; then docker compose start >/dev/null 2>&1 || true; fi
  if [ -n "${name:-}" ]; then rm -f -- "$out/$name.tgz.tmp"; fi
  exit 1
}
trap 'fail "unexpected error (line $LINENO)"' ERR

docker volume inspect "$vol" >/dev/null 2>&1 || fail "volume $vol not found"
[ -f network/genesis.json ] || fail "network/genesis.json missing"

block_hex=$(call eth_blockNumber '[]' | result)
[ -n "$block_hex" ] || fail "node not answering on $rpc"
block=$((block_hex))
chain_id=$(( $(call eth_chainId '[]' | result) ))
peers=$(( $(call net_peerCount '[]' | result) ))
expected=$(( $(grep -c 'enode://' network/static-nodes.json) - 1 ))
if [ "$peers" -lt "$expected" ] && [ "${FORCE:-}" != 1 ]; then
  fail "this node sees $peers of $expected peers: another node is down or disconnected, so stopping this one now could halt the chain (FORCE=1 to override)"
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="besu-chain-${NODE_NAME}-${stamp}-b${block}"
echo "snapshot of $NODE_NAME at block $block: stopping the node"
docker compose stop >/dev/null
stopped=1
# the image has tar but no gzip: stream the tar out and compress on the host; skip the node key
docker run --rm -u 0 --entrypoint tar -v "$vol":/data:ro "$BESU_IMAGE" cf - -C /data --exclude=./key . \
  | gzip -1 > "$out/$name.tgz.tmp"
docker compose start >/dev/null
stopped=0
echo "node started again"

# grep -c reads the whole listing (grep -q would stop early and break tar's pipe under pipefail)
tar tzf "$out/$name.tgz.tmp" | grep -c '^\./database/' >/dev/null || fail "archive has no database directory"
mv "$out/$name.tgz.tmp" "$out/$name.tgz"
size=$(stat -c %s "$out/$name.tgz")
cat > "$out/$name.json" <<EOF
{"node": "$NODE_NAME", "block": $block, "chainId": $chain_id, "createdAt": "$stamp",
 "genesisSha256": "$(sha256sum network/genesis.json | cut -d' ' -f1)",
 "archive": "$name.tgz", "archiveSha256": "$(sha256sum "$out/$name.tgz" | cut -d' ' -f1)", "sizeBytes": $size}
EOF

if [ -n "${COPY_TO:-}" ]; then
  rsync -a "$out/$name.tgz" "$out/$name.json" "$COPY_TO/" || fail "copy to $COPY_TO failed"
  echo "copied to $COPY_TO"
fi

# keep the newest $KEEP snapshots of this node
ls -1t "$out"/besu-chain-"${NODE_NAME}"-*.tgz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f -- "$old" "${old%.tgz}.json"
done

trap - ERR
backup_metric chain "$NODE_NAME" success "$size" "$block"
for i in $(seq 1 60); do [ -n "$(call eth_blockNumber '[]' | result)" ] && break; sleep 2; done
echo "snapshot: $out/$name.tgz ($(numfmt --to=iec "$size" 2>/dev/null || echo "$size bytes"), block $block)"
