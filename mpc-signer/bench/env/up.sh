#!/usr/bin/env bash
# Bring up Besu (single-node QBFT) + the OLD stack (Vault + Web3Signer) for the benchmark.
# Writes bench secrets to ./.secrets (git-ignored). Bench-only: Vault is initialised with a
# single unseal key so the run is unattended. Never do this in production.
set -Eeuo pipefail
cd "$(dirname "$0")"
BENCH="$(cd .. && pwd)"
. "$BENCH/lib.sh"
bench_deps
log() { printf '[bench-env] %s\n' "$*"; }

mkdir -p .secrets web3signer-keys
chmod 700 .secrets
chmod 755 web3signer-keys   # read by the web3signer container user (bench only)

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

docker compose up -d besu vault
for _ in $(seq 1 90); do
  curl -sf -H 'content-type: application/json' localhost:8545 \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' >/dev/null && break
  sleep 1
done
curl -sf -H 'content-type: application/json' localhost:8545 \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' >/dev/null \
  || { docker compose logs --tail 20 besu; log "besu did not start"; exit 1; }
log "besu up"

# ---------------------------------------------------------------- Vault
vexec() { docker compose exec -T -e VAULT_TOKEN="${VT:-}" vault vault "$@"; }
# `vault status` exits 2 when sealed, so never let its exit code decide
vstatus() { vexec status -format=json 2>/dev/null || true; }
for _ in $(seq 1 30); do vstatus | grep -q '"initialized"' && break; sleep 1; done
if ! vstatus | grep -q '"initialized": true'; then
  log "initialising vault (bench: 1 unseal key)"
  # write atomically: losing this file means losing the unseal key
  vexec operator init -key-shares=1 -key-threshold=1 -format=json > .secrets/vault-init.json.tmp
  mv .secrets/vault-init.json.tmp .secrets/vault-init.json
  rm -f .secrets/signer-token
fi
jfield() { tr -d '\n ' < "$1" | grep -o "\"$2\":[^,}]*" | head -n1 | sed -E 's/^"[^"]+":\[?"?([^"]*)"?.*/\1/'; }
UNSEAL=$(jfield .secrets/vault-init.json unseal_keys_b64)
VT=$(jfield .secrets/vault-init.json root_token)
vstatus | grep -q '"sealed": false' || vexec operator unseal "$UNSEAL" >/dev/null
log "vault unsealed"

vexec secrets list -format=json | grep -q '"web3signer/"' || vexec secrets enable -path=web3signer -version=2 kv >/dev/null
vexec policy write web3signer /vault/policies/web3signer.hcl >/dev/null

# bench sender keys (old stack): one for Web3Signer, one for the proxy's "sendFromVault" path
if [ ! -f .secrets/keys.json ]; then
  (cd "$BENCH" && nodejs -e '
    const {Wallet}=require("ethers");
    const a=Wallet.createRandom(), b=Wallet.createRandom();
    console.log(JSON.stringify({web3signer:{address:a.address,key:a.privateKey.slice(2)},vault:{address:b.address,key:b.privateKey.slice(2)}}));
  ') > .secrets/keys.json
fi
W3S_KEY=$(cd "$BENCH" && nodejs -e 'console.log(require("./env/.secrets/keys.json").web3signer.key)')
VAULT_KEY=$(cd "$BENCH" && nodejs -e 'console.log(require("./env/.secrets/keys.json").vault.key)')
printf '%s' "$W3S_KEY" | docker compose exec -T -e VAULT_TOKEN="$VT" vault sh -c 'read -r K; vault kv put web3signer/accounts/bench-w3s privateKey="$K" >/dev/null'
printf '%s' "$VAULT_KEY" | docker compose exec -T -e VAULT_TOKEN="$VT" vault sh -c 'read -r K; vault kv put web3signer/accounts/bench-vault privateKey="$K" >/dev/null'

if [ ! -f .secrets/signer-token ]; then
  vexec token create -policy=web3signer -display-name=web3signer -period=720h -orphan -field=token > .secrets/signer-token
fi
SIGNER_TOKEN=$(cat .secrets/signer-token)

umask 077
cat > web3signer-keys/bench.yaml <<EOF
type: "hashicorp"
keyType: "SECP256K1"
tlsEnabled: "false"
serverHost: "vault"
serverPort: "8200"
keyPath: "/v1/web3signer/data/accounts/bench-w3s"
keyName: "privateKey"
authMethod: "TOKEN"
token: "$SIGNER_TOKEN"
timeout: "10000"
EOF
umask 022
chmod 644 web3signer-keys/bench.yaml   # container user must read it (bench only)

docker compose --profile signer up -d web3signer
for _ in $(seq 1 90); do curl -sf localhost:9000/upcheck >/dev/null && break; sleep 1; done
log "web3signer up: $(curl -s localhost:9000 -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_accounts","params":[]}')"
