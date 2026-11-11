#!/usr/bin/env bash
# Full benchmark: OLD (Vault + Web3Signer, proxy-style Vault read + local sign) vs NEW (MPC).
# Everything runs in Docker by default: Besu + Vault + Web3Signer (bench/env) and the MPC
# cluster (quickstart/: 3 nodes + coordinator). Only Docker and bash/curl are required;
# the load generator uses the host's Node.js if installed, otherwise the node:22 image.
#
#   bench/run-bench.sh                         # MPC cluster in Docker (quickstart)
#   MPC_RUNTIME=native bench/run-bench.sh      # MPC cluster as host processes (scripts/local-cluster.sh)
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
      # Besu from bench/env is published on the host's :8545
      [ -f "$ROOT/quickstart/cluster.json" ] || MPC_BESU_RPC="${MPC_BESU_RPC:-http://host.docker.internal:8545}" "$QS" init
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
      curl -sf localhost:9100/health >/dev/null || MPC_BIN="${MPC_BIN:-$ROOT/target/release}" "$CLUSTER" start
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
log "environment: Besu + Vault + Web3Signer (docker), MPC cluster ($MPC_RUNTIME)"
"$BENCH/env/up.sh" >/dev/null
mpc_start
BIGINT="$(grep -s '^MPC_BIGINT=' "$ROOT/quickstart/.env" | cut -d= -f2 || true)"
emit "$(nodejs -e '
const os=require("os"), [rt, bi]=process.argv.slice(1);
console.log(JSON.stringify({label:"machine",cpus:os.cpus().length,cpu:os.cpus()[0].model,mem_gb:Math.round(os.totalmem()/2**30),
  mpc_runtime:rt, mpc_bigint:bi||null}))' "$MPC_RUNTIME" "${BIGINT:-}")"

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
  for t in w3s vault mpc; do
    emit "$(bench --label "B sign" --target "$t" --mode sign --concurrency "$c" --requests "$REQUESTS" --warmup "$WARMUP")"
  done
done

# ------------------------------------------------------------------ C
log "C: end-to-end (sign + submit + mined)"
set_target $((SEND_REQUESTS + 100))
while [ "$(ready)" -lt $((SEND_REQUESTS + 50)) ]; do sleep 2; done
pause_refill
for t in w3s vault mpc; do
  emit "$(bench --label "C send" --target "$t" --mode send --concurrency "$SEND_CONCURRENCY" --requests "$SEND_REQUESTS" --warmup 50)"
done

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
