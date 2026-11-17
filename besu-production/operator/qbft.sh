#!/usr/bin/env bash
# Run ON A VALIDATOR HOST (its RPC is on 127.0.0.1). QBFT validator management.
#   ./qbft.sh validators                 current validator set
#   ./qbft.sh propose 0xADDRESS true     vote to ADD a validator   (repeat on > half of the validators)
#   ./qbft.sh propose 0xADDRESS false    vote to REMOVE a validator
#   ./qbft.sh discard 0xADDRESS          withdraw this validator's pending vote
#   ./qbft.sh peers | health
#   RPC=http://127.0.0.1:8645 ./qbft.sh health   validator RPC on another port (several nodes per host)
set -Eeuo pipefail
RPC="${RPC:-http://127.0.0.1:8545}"
call() {
  local out
  out=$(curl -sS -m 10 "$RPC" -H 'Content-Type: application/json' \
        --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" 2>&1) || {
    echo "cannot reach a validator's JSON-RPC at $RPC: $out" >&2
    echo "run this on a validator host; if its RPC_PORT in .env is not 8545, set RPC=http://127.0.0.1:<RPC_PORT>" >&2
    exit 1; }
  [ -n "$out" ] || { echo "empty reply from $RPC" >&2; exit 1; }
  echo "$out"
}
case "${1:-}" in
  validators) call qbft_getValidatorsByBlockNumber '["latest"]' ;;
  propose) call qbft_proposeValidatorVote "[\"${2:?address}\", ${3:?true|false}]" ;;
  discard) call qbft_discardValidatorVote "[\"${2:?address}\"]" ;;
  peers) call admin_peers '[]' | grep -o '"enode":"[^"]*"' ;;
  health) call eth_blockNumber '[]'; call net_peerCount '[]'; call eth_syncing '[]' ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
