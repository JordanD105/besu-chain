#!/usr/bin/env bash
# Build the network files from the nodes' public JSON files (operator machine, Docker + Besu image).
#   CHAIN_ID=1337 ./make-network.sh out/ validator1.json validator2.json ... rpc1.json ...
# Writes out/genesis.json, out/static-nodes.json, out/permissions_config.toml, out/SHA256SUMS.
# Options (env):
#   BLOCK_PERIOD=2          seconds per block (1 on one LAN, >= 2 across sites)
#   REQUEST_TIMEOUT=4       QBFT round timeout seconds (>= 4 x inter-site RTT, and > BLOCK_PERIOD)
#   GAS_LIMIT=0x1c9c380        block gas limit (default 30,000,000). With gas price 0 this is the only cap on
#                              work per block: keep it modest (MPC policy MAX_GAS defaults to the same 30M)
#   ALLOC="0xSENDER01=1000000000000000000000000,0xOther=..."   prefunded accounts (wei)
set -Eeuo pipefail
out="${1:?output dir}"; shift
[ $# -ge 1 ] || { echo "usage: $0 OUTDIR node1.json [node2.json ...]" >&2; exit 1; }
CHAIN_ID="${CHAIN_ID:?set CHAIN_ID}"
BESU_IMAGE="${BESU_IMAGE:-hyperledger/besu:26.11.0}"
BLOCK_PERIOD="${BLOCK_PERIOD:-2}"; REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-4}"
GAS_LIMIT="${GAS_LIMIT:-0x1c9c380}"
mkdir -p "$out"; out="$(cd "$out" && pwd)"
field() { sed -E "s/.*\"$2\": *\"([^\"]*)\".*/\1/" "$1"; }
validators=(); enodes=()
for f in "$@"; do
  role=$(field "$f" role); enode=$(field "$f" enode); addr=$(field "$f" address)
  [[ "$enode" =~ ^enode://[0-9a-f]{128}@[^:]+:[0-9]+$ ]] || { echo "$f: bad enode" >&2; exit 1; }
  enodes+=("$enode")
  [ "$role" = validator ] && validators+=("$addr")
done
n=${#validators[@]}
[ "$n" -ge 4 ] || echo "WARNING: $n validators; QBFT needs >= 4 to tolerate one faulty validator" >&2
# QBFT extraData with the validator set, encoded by Besu itself
printf '[%s]\n' "$(printf '"%s",' "${validators[@]}" | sed 's/,$//')" > "$out/validators.json"
# encode from a temporary readable directory: $out may be private (mode 700), which Besu's user
# inside the container can't read. validators.json holds only public addresses.
enc="$(mktemp -d)"; trap 'rm -rf -- "$enc"' EXIT
chmod 755 "$enc"; cp "$out/validators.json" "$enc/"; chmod 644 "$enc/validators.json"
rlp=$(docker run --rm -v "$enc":/w:ro "$BESU_IMAGE" rlp encode --from=/w/validators.json --type=QBFT_EXTRA_DATA 2>&1) || true
extra=$(printf '%s\n' "$rlp" | grep -Eo '0x[0-9a-f]+' | tail -n1 || true)
[ -n "$extra" ] || { echo "rlp encode failed:" >&2; printf '%s\n' "$rlp" | tail -n 5 >&2; exit 1; }
alloc=""
IFS=',' read -ra items <<< "${ALLOC:-}"
for it in "${items[@]}"; do
  [ -n "$it" ] || continue
  a=${it%%=*}; b=${it#*=}
  [[ "$a" =~ ^0x[0-9a-fA-F]{40}$ && "$b" =~ ^[0-9]+$ ]] || { echo "bad ALLOC entry $it" >&2; exit 1; }
  alloc="${alloc:+$alloc,
}    \"${a#0x}\": { \"balance\": \"$b\" }"
done
cat > "$out/genesis.json" <<JSON
{
  "config": {
    "chainId": $CHAIN_ID,
    "berlinBlock": 0,
    "londonBlock": 0,
    "shanghaiTime": 0,
    "cancunTime": 0,
    "zeroBaseFee": true,
    "qbft": {
      "blockperiodseconds": $BLOCK_PERIOD,
      "epochlength": 30000,
      "requesttimeoutseconds": $REQUEST_TIMEOUT
    }
  },
  "nonce": "0x0",
  "timestamp": "0x$(printf '%x' "$(date +%s)")",
  "gasLimit": "$GAS_LIMIT",
  "difficulty": "0x1",
  "mixHash": "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
  "coinbase": "0x0000000000000000000000000000000000000000",
  "extraData": "$extra",
  "alloc": {
$alloc
  }
}
JSON
printf '[\n%s\n]\n' "$(printf '  "%s",\n' "${enodes[@]}" | sed '$ s/,$//')" > "$out/static-nodes.json"
printf 'nodes-allowlist=[\n%s\n]\n' "$(printf '  "%s",\n' "${enodes[@]}" | sed '$ s/,$//')" > "$out/permissions_config.toml"
rm -f "$out/validators.json"
(cd "$out" && sha256sum genesis.json static-nodes.json permissions_config.toml > SHA256SUMS)
echo "network files in $out: $n validators, ${#enodes[@]} nodes"; cat "$out/SHA256SUMS"
