#!/usr/bin/env sh
set -eu

TOKEN_FILE=".secrets/web3signer-token"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "Missing $TOKEN_FILE; run scripts/provision.sh first." >&2
  exit 1
fi

SIGNER_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"

docker compose exec -T \
  -e VAULT_TOKEN="$SIGNER_TOKEN" \
  vault vault token renew -increment=720h >/dev/null

unset SIGNER_TOKEN
echo "Web3Signer Vault token renewed."

