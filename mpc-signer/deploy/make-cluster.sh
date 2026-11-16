#!/usr/bin/env bash
# Build cluster.json from the three nodes' public key files (operator machine).
#   ./make-cluster.sh node0.json node1.json node2.json > cluster.json
# Policy (enforced by EVERY node): CHAIN_ID, MAX_VALUE_WEI, MAX_GAS, ALLOWED_TO (comma list)
set -Eeuo pipefail
[ $# -eq 3 ] || { echo "usage: $0 node0.json node1.json node2.json" >&2; exit 1; }
CHAIN_ID="${CHAIN_ID:?set CHAIN_ID (Besu genesis chainId)}"
MAX_VALUE_WEI="${MAX_VALUE_WEI:-1000000000000000000000}"
MAX_GAS="${MAX_GAS:-30000000}"
allowed=""
IFS=',' read -ra list <<< "${ALLOWED_TO:-}"
for a in "${list[@]}"; do [ -n "$a" ] && allowed="${allowed:+$allowed, }\"$a\""; done
i=0
for f in "$@"; do
  grep -q "\"id\": $i," "$f" || { echo "$f is not node $i (files must be in id order 0,1,2)" >&2; exit 1; }
  i=$((i + 1))
done
cat <<JSON
{
  "threshold": 2,
  "parties": [
    $(cat "$1"),
    $(cat "$2"),
    $(cat "$3")
  ],
  "policy": {
    "chain_id": $CHAIN_ID,
    "max_value_wei": "$MAX_VALUE_WEI",
    "max_gas": $MAX_GAS,
    "allowed_to": [${allowed}],
    "deny_contract_creation": false
  }
}
JSON
