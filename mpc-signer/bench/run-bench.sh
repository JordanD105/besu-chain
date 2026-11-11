#!/usr/bin/env bash
# Full benchmark: OLD (Vault + Web3Signer, proxy-style Vault read + local sign) vs NEW (MPC).
#
#   bench/run-bench.sh            # uses ./env (Besu+Vault+Web3Signer) and scripts/local-cluster.sh
#
# Phases
#   A  presignature generation capacity (the MPC's sustained signing ceiling)
#   B  signing throughput, pool pre-filled, refill paused   (MPC "hot" path vs old stack)
#   C  end-to-end: sign + submit to Besu + wait until mined
#   D  MPC cold path (no presignature: full interactive signing)
#   E  MPC sustained: pool empty at start, refill running during the load
set -Eeuo pipefail
cd "$(dirname "$0")"
BENCH="$PWD"
ROOT="$(cd .. && pwd)"
CLUSTER="$ROOT/scripts/local-cluster.sh"

REQUESTS="${REQUESTS:-1000}"
WARMUP="${WARMUP:-100}"
CONCURRENCIES="${CONCURRENCIES:-1 16 64}"
SEND_REQUESTS="${SEND_REQUESTS:-1000}"
SEND_CONCURRENCY="${SEND_CONCURRENCY:-32}"
COLD_REQUESTS="${COLD_REQUESTS:-24}"
COLD_CONCURRENCIES="${COLD_CONCURRENCIES:-1 4}"
SUSTAINED_REQUESTS="${SUSTAINED_REQUESTS:-150}"
SUSTAINED_CONCURRENCY="${SUSTAINED_CONCURRENCY:-16}"
REFILL_TARGET_MAX=100000

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p results
OUT="results/$STAMP.jsonl"
log() { printf '[bench] %s\n' "$*" >&2; }
admin() { "$CLUSTER" admin "$@"; }
pool() { curl -s localhost:9100/admin/pool; }
jq_() { node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log($1)"; }
ready() { pool | jq_ 'Object.values(j.pools).reduce((a,p)=>a+p.ready,0)'; }
inflight() { pool | jq_ 'Object.values(j.pools).reduce((a,p)=>a+p.inflight,0)'; }
generated() { pool | jq_ 'j.stats.presigs_generated'; }
set_target() { admin POST /admin/pool/target "{\"target\":$1}" >/dev/null; }
pause_refill() { set_target 0; while [ "$(inflight)" != "0" ]; do sleep 0.5; done; }
node_cpu() { # total utime+stime (seconds) of the 3 mpc-node processes
  local t=0 hz; hz=$(getconf CLK_TCK)
  for f in "$ROOT"/deploy/local/node*.pid; do
    t=$((t + $(awk '{print $14+$15}' "/proc/$(cat "$f")/stat")))
  done
  awk -v t="$t" -v hz="$hz" 'BEGIN{printf "%.2f", t/hz}'
}
emit() { echo "$1" | tee -a "$OUT"; }
bench() { node "$BENCH/bench.js" "$@"; }

log "environment"
"$BENCH/env/up.sh" >/dev/null
curl -sf localhost:9100/health >/dev/null || MPC_BIN="${MPC_BIN:-$ROOT/target/release}" "$CLUSTER" start
"$CLUSTER" setup >/dev/null
emit "$(node -e '
const os=require("os");
console.log(JSON.stringify({label:"machine",cpus:os.cpus().length,cpu:os.cpus()[0].model,mem_gb:Math.round(os.totalmem()/2**30),
  mpc_bin:process.env.MPC_BIN||"target/release",requests:+process.env.REQUESTS||1000}))')"

# ------------------------------------------------------------------ A
log "A: presignature generation capacity"
pause_refill
admin POST /admin/pool/clear >/dev/null
NEED=0; for c in $CONCURRENCIES; do NEED=$((NEED + REQUESTS + WARMUP)); done
NEED=$((NEED + 3 * 50))  # sanity checks
g0=$(generated); cpu0=$(node_cpu); t0=$(date +%s.%N)
set_target "$NEED"
while [ "$(ready)" -lt "$NEED" ]; do sleep 2; done
t1=$(date +%s.%N); cpu1=$(node_cpu); g1=$(generated)
pause_refill
emit "$(node -e "
const n=$g1-$g0, s=$t1-$t0, cpu=$cpu1-$cpu0;
console.log(JSON.stringify({label:'A presign capacity',presigs:n,seconds:+s.toFixed(1),presigs_per_s:+(n/s).toFixed(2),
 node_cpu_s_per_presig_per_party:+(cpu/n/2).toFixed(3), avg_session_ms:+JSON.parse(process.argv[1]).stats.avg_presign_ms.toFixed(0)}))" "$(pool)")"

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
emit "$(pool | jq_ 'JSON.stringify({label:"E pool stats",...j.stats})')"
set_target 200

node "$BENCH/report.js" "$OUT" > "results/$STAMP.md"
log "results: $BENCH/$OUT"
log "report:  $BENCH/results/$STAMP.md"
cat "results/$STAMP.md"
