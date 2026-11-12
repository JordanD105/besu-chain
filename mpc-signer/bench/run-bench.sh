#!/usr/bin/env bash
# Full benchmark: OLD (Vault + Web3Signer, proxy-style Vault read + local sign) vs NEW (MPC).
# Everything runs in Docker by default: Besu + Vault + Web3Signer (bench/env) and the MPC
# cluster (quickstart/: 3 nodes + coordinator). Only Docker and bash/curl are required;
# the load generator uses the host's Node.js if installed, otherwise the node:22 image.
#
#   bench/run-bench.sh                         # starts its own Besu + Vault + Web3Signer (bench/env)
#   OLD_STACK=existing bench/run-bench.sh      # use YOUR running Besu + Vault + Web3Signer instead
#   MPC_RUNTIME=native bench/run-bench.sh      # MPC cluster as host processes (scripts/local-cluster.sh)
#
# OLD_STACK=existing reads bench/existing.env if present (see existing.env.example). Defaults match
# ../besu-test-network + ../besu-vault-web3signer on this host. Nothing is deployed for the old
# stack; phase C (which submits real transactions) only runs with BENCH_SEND=1.
#
# Phases
#   A  presignature generation capacity (the MPC's sustained signing ceiling)
#   B  signing throughput, pool pre-filled, refill paused   (MPC "hot" path vs old stack)
#   C  end-to-end: sign + submit to Besu + wait until mined
#   D  MPC cold path (no presignature: full interactive signing)
#   E  MPC sustained: pool empty at start, refill running during the load
set -Eeuo pipefail
cd "$(dirname "$0")"
. ./lib.sh
BENCH="$BENCH_DIR"
ROOT="$MPC_ROOT"

MPC_RUNTIME="${MPC_RUNTIME:-docker}"
REQUESTS="${REQUESTS:-500}"
WARMUP="${WARMUP:-100}"
CONCURRENCIES="${CONCURRENCIES:-1 16 64}"
SEND_REQUESTS="${SEND_REQUESTS:-500}"
SEND_CONCURRENCY="${SEND_CONCURRENCY:-32}"
COLD_REQUESTS="${COLD_REQUESTS:-24}"
COLD_CONCURRENCIES="${COLD_CONCURRENCIES:-1 4}"
SUSTAINED_REQUESTS="${SUSTAINED_REQUESTS:-150}"
SUSTAINED_CONCURRENCY="${SUSTAINED_CONCURRENCY:-16}"

# ------------------------------------------------------------------ old stack
if [ -z "${OLD_STACK:-}" ] && [ -f "$BENCH/existing.env" ]; then OLD_STACK=existing; fi
OLD_STACK="${OLD_STACK:-bench}"
REPO="$(cd "$ROOT/.." && pwd)"
case "$OLD_STACK" in
  bench)
    TARGETS="w3s vault mpc"
    BENCH_SEND="${BENCH_SEND:-1}"
    ;;
  existing)
    # shellcheck disable=SC1091
    [ -f "$BENCH/existing.env" ] && { set -a; . "$BENCH/existing.env"; set +a; }
    BESU_RPC="${BESU_RPC:-http://127.0.0.1:8545}"
    W3S_RPC="${W3S_RPC:-http://127.0.0.1:9000}"
    VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
    VAULT_TOKEN_FILE="${VAULT_TOKEN_FILE:-$REPO/besu-vault-web3signer/.secrets/web3signer-token}"
    if [ -z "${VAULT_TOKEN:-}" ] && [ -r "$VAULT_TOKEN_FILE" ]; then VAULT_TOKEN="$(tr -d '\r\n' < "$VAULT_TOKEN_FILE")"; fi
    if [ -z "${VAULT_KEY_PATH:-}" ]; then
      VAULT_KEY_PATH="$(grep -sh 'keyPath:' "$REPO"/besu-vault-web3signer/web3signer/keys/*.yaml | head -n1 \
        | sed -E 's/.*"\/?v1\/([^"]+)".*/\1/' || true)"
    fi
    TARGETS="w3s"
    if [ -n "${VAULT_TOKEN:-}" ] && [ -n "${VAULT_KEY_PATH:-}" ]; then TARGETS="$TARGETS vault"; fi
    TARGETS="$TARGETS mpc"
    BENCH_SEND="${BENCH_SEND:-0}"
    export BESU_RPC W3S_RPC VAULT_ADDR VAULT_KEY_PATH
    [ -n "${VAULT_TOKEN:-}" ] && export VAULT_TOKEN
    [ -n "${W3S_FROM:-}" ] && export W3S_FROM
    ;;
  *) echo "OLD_STACK must be bench or existing"; exit 1 ;;
esac
BESU_RPC="${BESU_RPC:-http://127.0.0.1:8545}"
# the coordinator container reaches host-published services via host.docker.internal
MPC_BESU_RPC="${MPC_BESU_RPC:-$(printf '%s' "$BESU_RPC" | sed -E 's#//(127\.0\.0\.1|localhost)([:/]|$)#//host.docker.internal\2#')}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p results
OUT="results/$STAMP.jsonl"
log() { printf '[bench] %s\n' "$*" >&2; }
emit() { echo "$1" | tee -a "$OUT"; }
bench() { nodejs "$BENCH/bench.js" "$@"; }

# ------------------------------------------------------------------ MPC cluster control
QS="$ROOT/quickstart/quickstart.sh"
CLUSTER="$ROOT/scripts/local-cluster.sh"
case "$MPC_RUNTIME" in
  docker)
    admin() { "$QS" admin "$@"; }
    mpc_start() {
      [ -f "$ROOT/quickstart/cluster.json" ] || MPC_BESU_RPC="$MPC_BESU_RPC" CHAIN_ID="$CHAIN_ID" "$QS" init
      # point the coordinator at the same Besu the old stack uses
      sed -i "s#^MPC_BESU_RPC=.*#MPC_BESU_RPC=$MPC_BESU_RPC#" "$ROOT/quickstart/.env"
      "$QS" up >/dev/null
      "$QS" setup >/dev/null
    }
    node_pids() {
      local i id
      for i in 0 1 2; do
        id=$(docker compose -f "$ROOT/quickstart/docker-compose.yml" --project-directory "$ROOT/quickstart" ps -q "node$i")
        docker inspect -f '{{.State.Pid}}' "$id"
      done
    }
    ;;
  native)
    admin() { "$CLUSTER" admin "$@"; }
    mpc_start() {
      curl -sf localhost:9100/health >/dev/null || BESU_RPC="$BESU_RPC" CHAIN_ID="$CHAIN_ID" MPC_BIN="${MPC_BIN:-$ROOT/target/release}" "$CLUSTER" start
      "$CLUSTER" setup >/dev/null
    }
    node_pids() { cat "$ROOT"/deploy/local/node*.pid; }
    ;;
  *) echo "MPC_RUNTIME must be docker or native"; exit 1 ;;
esac

# total utime+stime (s) of the 3 mpc-node processes; "null" where /proc is not visible
# (e.g. Docker Desktop on macOS/Windows, where containers run inside a VM)
node_cpu() {
  local t=0 hz pid; hz=$(getconf CLK_TCK)
  for pid in $(node_pids); do
    [ -r "/proc/$pid/stat" ] || { echo null; return; }
    t=$((t + $(awk '{print $14+$15}' "/proc/$pid/stat")))
  done
  awk -v t="$t" -v hz="$hz" 'BEGIN{printf "%.2f", t/hz}'
}

# pool status, parsed without jq/node so polling stays cheap
pool() { curl -s localhost:9100/admin/pool; }
sum_field() { grep -o "\"$1\":[0-9]*" | awk -F: '{s+=$2} END{print s+0}'; }
ready() { pool | sum_field ready; }
inflight() { pool | sum_field inflight; }
generated() { pool | sum_field presigs_generated; }
set_target() { admin POST /admin/pool/target "{\"target\":$1}" >/dev/null; }
pause_refill() { set_target 0; while [ "$(inflight)" != "0" ]; do sleep 0.5; done; }

# ------------------------------------------------------------------ environment
rpc_result() { # URL METHOD -> result string
  curl -sf -H 'content-type: application/json' "$1" \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}" | sed -E 's/.*"result":"?([^"}]*)"?.*/\1/'
}
if [ "$OLD_STACK" = bench ]; then
  log "environment: bench Besu + Vault + Web3Signer (docker), MPC cluster ($MPC_RUNTIME)"
  "$BENCH/env/up.sh" >/dev/null
else
  log "environment: EXISTING stack - Besu $BESU_RPC, Web3Signer $W3S_RPC, Vault $VAULT_ADDR; MPC cluster ($MPC_RUNTIME)"
  bench_deps
  rpc_result "$BESU_RPC" eth_chainId >/dev/null || { log "Besu not reachable at $BESU_RPC (set BESU_RPC)"; exit 1; }
  curl -sf "$W3S_RPC/upcheck" >/dev/null || { log "Web3Signer not reachable at $W3S_RPC (set W3S_RPC)"; exit 1; }
  if [[ " $TARGETS " == *" vault "* ]]; then
    curl -s -o /dev/null "$VAULT_ADDR/v1/sys/health" || { log "Vault not reachable at $VAULT_ADDR (set VAULT_ADDR)"; exit 1; }
    log "vault target: reads $VAULT_KEY_PATH per transaction (like proxy sendFromVault)"
  else
    log "vault target skipped: set VAULT_TOKEN (or VAULT_TOKEN_FILE) and VAULT_KEY_PATH to include it"
  fi
  [ "$BENCH_SEND" = 1 ] || log "phase C skipped (it submits real transactions); set BENCH_SEND=1 to run it"
fi
CHAIN_ID="${CHAIN_ID:-$(( $(rpc_result "$BESU_RPC" eth_chainId) ))}"
export CHAIN_ID
mpc_start
if [ "$MPC_RUNTIME" = docker ]; then
  policy_chain=$(grep -o '"chain_id": *[0-9]*' "$ROOT/quickstart/cluster.json" | grep -o '[0-9]*$')
  [ "$policy_chain" = "$CHAIN_ID" ] || { log "MPC policy chain_id $policy_chain != Besu chain id $CHAIN_ID: fix quickstart/cluster.json and restart the nodes"; exit 1; }
fi
BIGINT="$(grep -s '^MPC_BIGINT=' "$ROOT/quickstart/.env" | cut -d= -f2 || true)"
emit "$(nodejs -e '
const os=require("os"), [rt, bi]=process.argv.slice(1);
console.log(JSON.stringify({label:"machine",cpus:os.cpus().length,cpu:os.cpus()[0].model,mem_gb:Math.round(os.totalmem()/2**30),
  mpc_runtime:rt, mpc_bigint:bi||null, old_stack:process.argv[3]}))' "$MPC_RUNTIME" "${BIGINT:-}" "$OLD_STACK")"

# ------------------------------------------------------------------ A
log "A: presignature generation capacity"
pause_refill
admin POST /admin/pool/clear >/dev/null
NEED=0; for c in $CONCURRENCIES; do NEED=$((NEED + REQUESTS + WARMUP)); done
g0=$(generated); cpu0=$(node_cpu); t0=$(date +%s.%N)
set_target "$NEED"
while [ "$(ready)" -lt "$NEED" ]; do sleep 2; done
t1=$(date +%s.%N); cpu1=$(node_cpu); g1=$(generated)
avg=$(pool | grep -o '"avg_presign_ms":[0-9.]*' | cut -d: -f2)
pause_refill
emit "$(awk -v n=$((g1 - g0)) -v t0="$t0" -v t1="$t1" -v c0="$cpu0" -v c1="$cpu1" -v avg="${avg:-0}" 'BEGIN{
  s=t1-t0; cpu=(c0=="null"||c1=="null") ? "null" : sprintf("%.3f",(c1-c0)/n/2);
  printf "{\"label\":\"A presign capacity\",\"presigs\":%d,\"seconds\":%.1f,\"presigs_per_s\":%.2f,\"avg_session_ms\":%d,\"node_cpu_s_per_presig_per_party\":%s}\n", n, s, n/s, avg, cpu }')"

# ------------------------------------------------------------------ B
log "B: signing throughput (refill paused)"
for c in $CONCURRENCIES; do
  for t in $TARGETS; do
    emit "$(bench --label "B sign" --target "$t" --mode sign --concurrency "$c" --requests "$REQUESTS" --warmup "$WARMUP")"
  done
done

# ------------------------------------------------------------------ C
if [ "$BENCH_SEND" = 1 ]; then
  log "C: end-to-end (sign + submit + mined)"
  set_target $((SEND_REQUESTS + 100))
  while [ "$(ready)" -lt $((SEND_REQUESTS + 50)) ]; do sleep 2; done
  pause_refill
  for t in $TARGETS; do
    emit "$(bench --label "C send" --target "$t" --mode send --concurrency "$SEND_CONCURRENCY" --requests "$SEND_REQUESTS" --warmup 50)"
  done
fi

# ------------------------------------------------------------------ D
log "D: MPC cold path (no presignatures)"
admin POST /admin/pool/clear >/dev/null
for c in $COLD_CONCURRENCIES; do
  emit "$(bench --label "D cold" --target mpc --mode sign --concurrency "$c" --requests "$COLD_REQUESTS")"
done

# ------------------------------------------------------------------ E
log "E: MPC sustained (empty pool, refill running)"
set_target 200
emit "$(bench --label "E sustained" --target mpc --mode sign --concurrency "$SUSTAINED_CONCURRENCY" --requests "$SUSTAINED_REQUESTS")"
emit "$(pool | sed -E 's/.*"stats":(\{[^}]*\}).*/\1/; s/^\{/{"label":"E pool stats",/')"

nodejs "$BENCH/report.js" "$OUT" > "results/$STAMP.md"
log "results: $BENCH/$OUT"
log "report:  $BENCH/results/$STAMP.md"
cat "results/$STAMP.md"
