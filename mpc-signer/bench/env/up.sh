#!/usr/bin/env bash
# Bring up the benchmark's Besu test chain: one single-validator QBFT node on localhost:8545.
# The genesis and node key are generated once into ./besu-net (git-ignored).
set -Eeuo pipefail
cd "$(dirname "$0")"
log() { printf '[bench-env] %s\n' "$*"; }

# ---------------------------------------------------------------- Besu genesis
if [ ! -f besu-net/node.key ]; then
  log "generating single-validator QBFT genesis"
  rm -rf besu-net
  docker run --rm -u 0 -v "$PWD":/w hyperledger/besu:"${BESU_VERSION:-latest}" \
    operator generate-blockchain-config --config-file=/w/qbft-config.json \
    --to=/w/besu-net --private-key-file-name=key >/dev/null 2>&1 || true
  cp besu-net/keys/*/key besu-net/node.key
  chmod 644 besu-net/node.key besu-net/genesis.json
fi

docker compose up -d besu
for _ in $(seq 1 90); do
  curl -sf -H 'content-type: application/json' localhost:8545 \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' >/dev/null && break
  sleep 1
done
curl -sf -H 'content-type: application/json' localhost:8545 \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' >/dev/null \
  || { docker compose logs --tail 20 besu; log "besu did not start"; exit 1; }
log "besu up"
