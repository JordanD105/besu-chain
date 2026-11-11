#!/usr/bin/env bash

set -Eeuo pipefail

KEYS_DIRECTORY="${GENESIS_KEYS_DIR:-./genesis-keys}"
VAULT_SERVICE="${VAULT_SERVICE:-vault}"
VAULT_MOUNT="${VAULT_MOUNT:-web3signer}"
VAULT_ACCOUNT_PREFIX="${VAULT_ACCOUNT_PREFIX:-accounts}"
POLICY_NAME="${POLICY_NAME:-web3signer}"
POLICY_FILE="${POLICY_FILE:-/vault/policies/web3signer.hcl}"

SECRETS_DIRECTORY="${SECRETS_DIRECTORY:-./.secrets}"
WEB3SIGNER_KEYS_DIRECTORY="${WEB3SIGNER_KEYS_DIRECTORY:-./web3signer/keys}"
WEB3SIGNER_CONFIG_FILE="${WEB3SIGNER_CONFIG_FILE:-$WEB3SIGNER_KEYS_DIRECTORY/senders.yaml}"
TOKEN_FILE="${TOKEN_FILE:-$SECRETS_DIRECTORY/web3signer-token}"

VAULT_HOST="${WEB3SIGNER_VAULT_HOST:-vault}"
VAULT_PORT="${WEB3SIGNER_VAULT_PORT:-8200}"
VAULT_TLS_ENABLED="${WEB3SIGNER_VAULT_TLS_ENABLED:-false}"

TOKEN_PERIOD="${WEB3SIGNER_TOKEN_PERIOD:-720h}"

log() {
  printf '[provision] %s\n' "$1"
}

fail() {
  printf '[provision] ERROR: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  unset SIGNER_TOKEN 2>/dev/null || true
}

trap cleanup EXIT
trap 'fail "Provisioning failed near line $LINENO."' ERR

command -v docker >/dev/null 2>&1 ||
  fail "Docker is not installed or not available in PATH."

docker compose version >/dev/null 2>&1 ||
  fail "Docker Compose v2 is not available."

[ -n "${VAULT_TOKEN:-}" ] ||
  fail "VAULT_TOKEN is required."

[ -d "$KEYS_DIRECTORY" ] ||
  fail "Genesis keys directory does not exist: $KEYS_DIRECTORY"

docker compose ps --status running "$VAULT_SERVICE" |
  grep -q "$VAULT_SERVICE" ||
  fail "Vault container is not running."

VAULT_STATUS="$(
  docker compose exec -T "$VAULT_SERVICE" \
    vault status -format=json 2>/dev/null || true
)"

printf '%s' "$VAULT_STATUS" |
  grep -q '"initialized"[[:space:]]*:[[:space:]]*true' ||
  fail "Vault is not initialized."

printf '%s' "$VAULT_STATUS" |
  grep -q '"sealed"[[:space:]]*:[[:space:]]*false' ||
  fail "Vault is sealed. Unseal Vault before provisioning."

if ! docker compose exec -T \
  -e VAULT_TOKEN="$VAULT_TOKEN" \
  "$VAULT_SERVICE" \
  vault token lookup >/dev/null 2>&1; then
  fail "VAULT_TOKEN is invalid or does not have access to Vault."
fi

KEY_COUNT=0

for key_file in "$KEYS_DIRECTORY"/*.key; do
  if [ -f "$key_file" ]; then
    KEY_COUNT=$((KEY_COUNT + 1))
  fi
done

[ "$KEY_COUNT" -gt 0 ] ||
  fail "No .key files were found in $KEYS_DIRECTORY"

log "Found $KEY_COUNT private-key files."

mkdir -p "$SECRETS_DIRECTORY"
mkdir -p "$WEB3SIGNER_KEYS_DIRECTORY"

chmod 700 "$SECRETS_DIRECTORY"
chmod 700 "$WEB3SIGNER_KEYS_DIRECTORY"

umask 077

log "Checking Vault KV v2 mount: $VAULT_MOUNT"

if ! docker compose exec -T \
  -e VAULT_TOKEN="$VAULT_TOKEN" \
  "$VAULT_SERVICE" \
  vault secrets list -format=json |
  grep -q "\"${VAULT_MOUNT}/\""; then

  docker compose exec -T \
    -e VAULT_TOKEN="$VAULT_TOKEN" \
    "$VAULT_SERVICE" \
    vault secrets enable \
      -path="$VAULT_MOUNT" \
      -version=2 \
      kv

  log "Enabled Vault KV v2 at $VAULT_MOUNT/"
else
  log "Vault mount already exists."
fi

log "Installing Web3Signer Vault policy."

docker compose exec -T \
  -e VAULT_TOKEN="$VAULT_TOKEN" \
  "$VAULT_SERVICE" \
  vault policy write \
    "$POLICY_NAME" \
    "$POLICY_FILE"

log "Importing genesis private keys into Vault."

for key_file in "$KEYS_DIRECTORY"/*.key; do
  [ -f "$key_file" ] || continue

  file_name="$(basename "$key_file")"
  account_name="${file_name%.key}"

  case "$account_name" in
    *[!a-zA-Z0-9_-]*|'')
      fail "Invalid account filename: $file_name"
      ;;
  esac

  log "Importing $account_name"

  docker compose exec -T \
    -e VAULT_TOKEN="$VAULT_TOKEN" \
    -e ACCOUNT_NAME="$account_name" \
    -e VAULT_MOUNT="$VAULT_MOUNT" \
    -e VAULT_ACCOUNT_PREFIX="$VAULT_ACCOUNT_PREFIX" \
    "$VAULT_SERVICE" \
    sh -ec '
      IFS= read -r PRIVATE_KEY || true

      PRIVATE_KEY="${PRIVATE_KEY#0x}"
      PRIVATE_KEY="${PRIVATE_KEY#0X}"

      case "$PRIVATE_KEY" in
        *[!0-9a-fA-F]*|"")
          echo "Invalid hexadecimal private key for $ACCOUNT_NAME" >&2
          exit 1
          ;;
      esac

      if [ "${#PRIVATE_KEY}" -ne 64 ]; then
        echo "Private key for $ACCOUNT_NAME must be 64 hexadecimal characters." >&2
        exit 1
      fi

      vault kv put \
        "$VAULT_MOUNT/$VAULT_ACCOUNT_PREFIX/$ACCOUNT_NAME" \
        privateKey="$PRIVATE_KEY" >/dev/null

      unset PRIVATE_KEY
    ' < "$key_file"
done

log "Creating a restricted periodic token for Web3Signer."

SIGNER_TOKEN="$(
  docker compose exec -T \
    -e VAULT_TOKEN="$VAULT_TOKEN" \
    "$VAULT_SERVICE" \
    vault token create \
      -policy="$POLICY_NAME" \
      -display-name="web3signer" \
      -period="$TOKEN_PERIOD" \
      -orphan \
      -field=token |
      tr -d '\r\n'
)"

[ -n "$SIGNER_TOKEN" ] ||
  fail "Vault did not return a Web3Signer token."

printf '%s\n' "$SIGNER_TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

TEMP_CONFIG="${WEB3SIGNER_CONFIG_FILE}.tmp"

: > "$TEMP_CONFIG"
chmod 600 "$TEMP_CONFIG"

DOCUMENT_NUMBER=0

log "Generating combined Web3Signer configuration."

for key_file in "$KEYS_DIRECTORY"/*.key; do
  [ -f "$key_file" ] || continue

  file_name="$(basename "$key_file")"
  account_name="${file_name%.key}"

  if [ "$DOCUMENT_NUMBER" -gt 0 ]; then
    printf '\n---\n\n' >> "$TEMP_CONFIG"
  fi

  cat >> "$TEMP_CONFIG" <<EOF
type: "hashicorp"
keyType: "SECP256K1"

tlsEnabled: "$VAULT_TLS_ENABLED"
serverHost: "$VAULT_HOST"
serverPort: "$VAULT_PORT"

keyPath: "/v1/$VAULT_MOUNT/data/$VAULT_ACCOUNT_PREFIX/$account_name"
keyName: "privateKey"

authMethod: "TOKEN"
token: "$SIGNER_TOKEN"

timeout: "10000"
EOF

  DOCUMENT_NUMBER=$((DOCUMENT_NUMBER + 1))
done

mv "$TEMP_CONFIG" "$WEB3SIGNER_CONFIG_FILE"
chmod 600 "$WEB3SIGNER_CONFIG_FILE"

unset SIGNER_TOKEN

log "Provisioning completed."
log "Imported accounts: $KEY_COUNT"
log "Configuration: $WEB3SIGNER_CONFIG_FILE"
log "Token file: $TOKEN_FILE"
log ""
log "Next commands:"
log "  docker compose up -d web3signer"
log "  docker compose logs -f web3signer"