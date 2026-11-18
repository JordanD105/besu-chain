#!/usr/bin/env bash
# One-time key ceremony, run from the operator/bastion against ONE coordinator, with all 3 nodes up.
#   COORD=http://192.168.68.132:9100 ADMIN_TOKEN=... ./ceremony.sh
# 1) aux info (safe primes + ZK proofs; minutes, once per cluster)  2) first key = SENDER01
set -Eeuo pipefail
: "${COORD:?coordinator URL}" "${ADMIN_TOKEN:?admin token}"
api() { curl -sS --fail-with-body -X "$1" "$COORD$2" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json'; }
echo "[ceremony] aux info generation (all 3 nodes, a few minutes)"
api POST /admin/aux; echo
if [ "$(api GET /admin/keys)" = "[]" ]; then
  echo "[ceremony] distributed key generation"
  api POST /admin/keys; echo
fi
echo "[ceremony] keys (the first address is SENDER01):"
api GET /admin/keys; echo
