#!/usr/bin/env bash
# One-time/re-runnable bootstrap for Docker Compose + Vault + Web3Signer.
#
# Required existing inputs:
#   docker-compose.yml with services named "vault" and "web3signer"
#   genesis-keys/*.key (one 32-byte secp256k1 private key per file)
#
# The Vault service must persist /vault/file in a Docker volume.
# The Web3Signer service must mount ./web3signer/keys read-only at its key-store path.

set -Eeuo pipefail
umask 077

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.yml}"
VAULT_SERVICE="${VAULT_SERVICE:-vault}"
WEB3SIGNER_SERVICE="${WEB3SIGNER_SERVICE:-web3signer}"
KEYS_DIR="${GENESIS_KEYS_DIR:-$PROJECT_DIR/genesis-keys}"
SECRETS_DIR="${SECRETS_DIR:-$PROJECT_DIR/.secrets}"
INIT_FILE="${VAULT_INIT_FILE:-$SECRETS_DIR/vault-init.json}"
TOKEN_FILE="${WEB3SIGNER_TOKEN_FILE:-$SECRETS_DIR/web3signer-token}"
SIGNER_KEYS_DIR="${WEB3SIGNER_KEYS_DIR:-$PROJECT_DIR/web3signer/keys}"
SIGNERS_FILE="${WEB3SIGNER_CONFIG_FILE:-$SIGNER_KEYS_DIR/senders.yaml}"

VAULT_MOUNT="${VAULT_MOUNT:-web3signer}"
ACCOUNT_PREFIX="${VAULT_ACCOUNT_PREFIX:-accounts}"
POLICY_NAME="${VAULT_POLICY_NAME:-web3signer}"
TOKEN_PERIOD="${WEB3SIGNER_TOKEN_PERIOD:-168h}"
VAULT_HOST="${WEB3SIGNER_VAULT_HOST:-vault}"
VAULT_PORT="${WEB3SIGNER_VAULT_PORT:-8200}"
VAULT_TLS="${WEB3SIGNER_VAULT_TLS_ENABLED:-false}"
WEB3SIGNER_URL="${WEB3SIGNER_URL:-http://127.0.0.1:9000}"

COMPOSE=(docker compose -f "$COMPOSE_FILE" --project-directory "$PROJECT_DIR")
ROOT_TOKEN=""
SIGNER_TOKEN=""

log()  { printf '[bootstrap] %s\n' "$*"; }
fail() { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }
cleanup() { unset ROOT_TOKEN SIGNER_TOKEN key_value 2>/dev/null || true; }
trap cleanup EXIT
trap 'fail "Failed near line $LINENO"' ERR

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

vault_exec() {
  "${COMPOSE[@]}" exec -T -e VAULT_TOKEN="$ROOT_TOKEN" "$VAULT_SERVICE" vault "$@"
}

require_command docker
require_command jq
require_command curl
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
[[ -f "$COMPOSE_FILE" ]] || fail "Compose file not found: $COMPOSE_FILE"
[[ -d "$KEYS_DIR" ]] || fail "Genesis key directory not found: $KEYS_DIR"

shopt -s nullglob
key_files=("$KEYS_DIR"/*.key)
((${#key_files[@]} > 0)) || fail "No .key files found in $KEYS_DIR"

mkdir -p "$SECRETS_DIR" "$SIGNER_KEYS_DIR"
chmod 700 "$SECRETS_DIR" "$SIGNER_KEYS_DIR"

log "Starting Vault"
"${COMPOSE[@]}" up -d "$VAULT_SERVICE"

log "Waiting for Vault API"
vault_status=""
for _ in {1..60}; do
  vault_status="$("${COMPOSE[@]}" exec -T "$VAULT_SERVICE" vault status -format=json 2>/dev/null || true)"
  if jq -e 'has("initialized") and has("sealed")' >/dev/null 2>&1 <<<"$vault_status"; then
    break
  fi
  sleep 1
done
jq -e 'has("initialized") and has("sealed")' >/dev/null 2>&1 <<<"$vault_status" ||
  fail "Vault did not become ready. Check: docker compose logs $VAULT_SERVICE"

if [[ "$(jq -r '.initialized' <<<"$vault_status")" == "false" ]]; then
  [[ ! -e "$INIT_FILE" ]] || fail "Vault is uninitialized but $INIT_FILE already exists; refusing to overwrite it."
  log "Initializing Vault with 5 recovery shares and threshold 3"
  "${COMPOSE[@]}" exec -T "$VAULT_SERVICE" vault operator init \
    -key-shares=5 -key-threshold=3 -format=json >"$INIT_FILE"
  chmod 600 "$INIT_FILE"
  jq -e '.root_token and (.unseal_keys_b64 | length >= 3)' "$INIT_FILE" >/dev/null ||
    fail "Vault initialization output is invalid."
  vault_status="$("${COMPOSE[@]}" exec -T "$VAULT_SERVICE" vault status -format=json 2>/dev/null || true)"
else
  log "Vault is already initialized"
fi

[[ -r "$INIT_FILE" ]] ||
  fail "Vault is initialized, but $INIT_FILE is unavailable. Supply VAULT_INIT_FILE or unseal/authenticate manually."

if [[ "$(jq -r '.sealed' <<<"$vault_status")" == "true" ]]; then
  log "Unsealing Vault"
  for index in 0 1 2; do
    unseal_key="$(jq -r ".unseal_keys_b64[$index]" "$INIT_FILE")"
    [[ -n "$unseal_key" && "$unseal_key" != "null" ]] || fail "Missing unseal key $index"
    "${COMPOSE[@]}" exec -T -e VAULT_UNSEAL_KEY="$unseal_key" "$VAULT_SERVICE" \
      sh -ec 'vault operator unseal "$VAULT_UNSEAL_KEY" >/dev/null'
    unset unseal_key
  done
fi

vault_status="$("${COMPOSE[@]}" exec -T "$VAULT_SERVICE" vault status -format=json 2>/dev/null || true)"
[[ "$(jq -r '.sealed' <<<"$vault_status")" == "false" ]] || fail "Vault remains sealed."

ROOT_TOKEN="$(jq -r '.root_token' "$INIT_FILE")"
[[ -n "$ROOT_TOKEN" && "$ROOT_TOKEN" != "null" ]] || fail "Root token missing from $INIT_FILE"
vault_exec token lookup >/dev/null

if vault_exec secrets list -format=json | jq -e --arg mount "$VAULT_MOUNT/" 'has($mount)' >/dev/null; then
  mount_type="$(vault_exec secrets list -format=json | jq -r --arg mount "$VAULT_MOUNT/" '.[$mount].type')"
  mount_version="$(vault_exec secrets list -format=json | jq -r --arg mount "$VAULT_MOUNT/" '.[$mount].options.version // "1"')"
  [[ "$mount_type" == "kv" && "$mount_version" == "2" ]] ||
    fail "$VAULT_MOUNT/ exists but is not a KV v2 mount."
  log "KV v2 mount already exists: $VAULT_MOUNT/"
else
  log "Enabling KV v2 mount: $VAULT_MOUNT/"
  vault_exec secrets enable -path="$VAULT_MOUNT" -version=2 kv >/dev/null
fi

log "Installing least-privilege Web3Signer policy"
printf 'path "%s/data/%s/*" {\n  capabilities = ["read"]\n}\n' "$VAULT_MOUNT" "$ACCOUNT_PREFIX" |
  "${COMPOSE[@]}" exec -T -e VAULT_TOKEN="$ROOT_TOKEN" "$VAULT_SERVICE" \
    vault policy write "$POLICY_NAME" - >/dev/null

log "Validating and importing ${#key_files[@]} sender key(s)"
account_names=()
for key_file in "${key_files[@]}"; do
  account_name="$(basename "$key_file" .key)"
  [[ "$account_name" =~ ^[A-Za-z0-9_-]+$ ]] || fail "Invalid key filename: $(basename "$key_file")"

  key_value="$(tr -d '[:space:]' <"$key_file")"
  key_value="${key_value#0x}"
  key_value="${key_value#0X}"
  [[ "$key_value" =~ ^[0-9a-fA-F]{64}$ ]] || fail "$key_file must contain one 64-hex-character private key."

  printf '%s\n' "$key_value" |
    "${COMPOSE[@]}" exec -T \
      -e VAULT_TOKEN="$ROOT_TOKEN" \
      -e SECRET_PATH="$VAULT_MOUNT/$ACCOUNT_PREFIX/$account_name" \
      "$VAULT_SERVICE" sh -ec '
        IFS= read -r private_key
        vault kv put "$SECRET_PATH" privateKey="$private_key" >/dev/null
        unset private_key
      '
  unset key_value
  account_names+=("$account_name")
  log "Imported $account_name"
done

if [[ -s "$TOKEN_FILE" ]]; then
  candidate_token="$(tr -d '\r\n' <"$TOKEN_FILE")"
  if "${COMPOSE[@]}" exec -T -e VAULT_TOKEN="$candidate_token" "$VAULT_SERVICE" \
      vault token lookup >/dev/null 2>&1; then
    SIGNER_TOKEN="$candidate_token"
    log "Reusing the existing valid Web3Signer token"
  else
    log "Existing Web3Signer token is invalid or expired; creating a replacement"
  fi
  unset candidate_token
fi

if [[ -z "$SIGNER_TOKEN" ]]; then
  SIGNER_TOKEN="$(vault_exec token create \
    -policy="$POLICY_NAME" \
    -display-name=web3signer \
    -period="$TOKEN_PERIOD" \
    -orphan \
    -field=token | tr -d '\r\n')"
  [[ -n "$SIGNER_TOKEN" ]] || fail "Vault did not return a Web3Signer token."
  printf '%s\n' "$SIGNER_TOKEN" >"$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi

log "Generating one combined Web3Signer YAML file"
temp_signers="$(mktemp "$SIGNER_KEYS_DIR/.senders.yaml.XXXXXX")"
chmod 600 "$temp_signers"
for index in "${!account_names[@]}"; do
  account_name="${account_names[$index]}"
  ((index == 0)) || printf '\n---\n\n' >>"$temp_signers"
  cat >>"$temp_signers" <<EOF
type: "hashicorp"
keyType: "SECP256K1"
tlsEnabled: "$VAULT_TLS"
serverHost: "$VAULT_HOST"
serverPort: "$VAULT_PORT"
keyPath: "/v1/$VAULT_MOUNT/data/$ACCOUNT_PREFIX/$account_name"
keyName: "privateKey"
authMethod: "TOKEN"
token: "$SIGNER_TOKEN"
timeout: "10000"
EOF
done

mv -f "$temp_signers" "$SIGNERS_FILE"

log "Detecting Web3Signer container user"

WEB3SIGNER_UID="$(
  "${COMPOSE[@]}" run --rm --no-deps \
    --entrypoint sh \
    "$WEB3SIGNER_SERVICE" \
    -c 'id -u' |
  tail -n 1 |
  tr -d '\r'
)"

WEB3SIGNER_GID="$(
  "${COMPOSE[@]}" run --rm --no-deps \
    --entrypoint sh \
    "$WEB3SIGNER_SERVICE" \
    -c 'id -g' |
  tail -n 1 |
  tr -d '\r'
)"

[[ "$WEB3SIGNER_UID" =~ ^[0-9]+$ ]] ||
  fail "Could not determine Web3Signer UID."

[[ "$WEB3SIGNER_GID" =~ ^[0-9]+$ ]] ||
  fail "Could not determine Web3Signer GID."

log "Web3Signer runs as UID=$WEB3SIGNER_UID GID=$WEB3SIGNER_GID"

# Set permissions before changing ownership.
chmod 700 "$SIGNER_KEYS_DIR"
chmod 600 "$SIGNERS_FILE"

if [[ "$EUID" -eq 0 ]]; then
  chown -R \
    "$WEB3SIGNER_UID:$WEB3SIGNER_GID" \
    "$SIGNER_KEYS_DIR"
else
  command -v sudo >/dev/null 2>&1 ||
    fail "sudo is required to change Web3Signer key ownership."

  sudo chown -R \
    "$WEB3SIGNER_UID:$WEB3SIGNER_GID" \
    "$SIGNER_KEYS_DIR"
fi

log "Starting/recreating Web3Signer"

"${COMPOSE[@]}" up -d --force-recreate "$WEB3SIGNER_SERVICE"

log "Waiting for Web3Signer to load all sender accounts"

EXPECTED_ACCOUNT_COUNT="${#account_names[@]}"
accounts_response=""
loaded_count=0

for _ in {1..90}; do
  accounts_response="$(
    curl -fsS "$WEB3SIGNER_URL" \
      -H "Content-Type: application/json" \
      --data '{
        "jsonrpc":"2.0",
        "id":1,
        "method":"eth_accounts",
        "params":[]
      }' 2>/dev/null || true
  )"

  loaded_count="$(
    jq -r '
      if (.result | type) == "array" then
        (.result | length)
      else
        0
      end
    ' <<< "$accounts_response" 2>/dev/null || printf '0'
  )"

  if [[ "$loaded_count" =~ ^[0-9]+$ ]] &&
     (( loaded_count == EXPECTED_ACCOUNT_COUNT )); then
    break
  fi

  sleep 1
done

if [[ ! "$loaded_count" =~ ^[0-9]+$ ]] ||
   (( loaded_count != EXPECTED_ACCOUNT_COUNT )); then
  "${COMPOSE[@]}" logs --tail=100 "$WEB3SIGNER_SERVICE" >&2 || true

  fail "Expected $EXPECTED_ACCOUNT_COUNT accounts, but Web3Signer loaded ${loaded_count:-0}."
fi

log "Bootstrap completed successfully."
log "Web3Signer accounts:"

jq -r '.result[] | "  " + .' <<< "$accounts_response"

log "Loaded accounts: $loaded_count"
log "Renew the periodic token before $TOKEN_PERIOD elapses."

log "Move $INIT_FILE and the original .key files to secure offline storage after verification."
