#!/usr/bin/env bash
# Run a 2-of-3 MPC signer cluster on one host (development / benchmarking).
#
#   scripts/local-cluster.sh init     # identities, cluster.json, tokens (once)
#   scripts/local-cluster.sh start    # start 3 nodes + coordinator
#   scripts/local-cluster.sh setup    # aux info (slow, once) + one key
#   scripts/local-cluster.sh stop
#
# In production every node runs on a different host, under a different admin.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${MPC_LOCAL_DIR:-$ROOT/deploy/local}"
BIN="${MPC_BIN:-$ROOT/target/release}"
CHAIN_ID="${CHAIN_ID:-1337}"
BESU_RPC="${BESU_RPC:-http://127.0.0.1:8545}"
COORD_PORT="${COORD_PORT:-9100}"
POOL_TARGET="${POOL_TARGET:-200}"
REFILL_CONCURRENCY="${REFILL_CONCURRENCY:-4}"
COMPUTE_THREADS="${COMPUTE_THREADS:-2}"
N=3

log() { printf '[mpc] %s\n' "$*"; }
rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

init() {
  [ -f "$DIR/cluster.json" ] && { log "already initialised: $DIR"; return; }
  mkdir -p "$DIR/secrets" "$DIR/logs"
  chmod 700 "$DIR/secrets"
  umask 077
  rand > "$DIR/secrets/node-token"
  rand > "$DIR/secrets/admin-token"
  local parties=""
  for i in $(seq 0 $((N - 1))); do
    rand > "$DIR/secrets/node$i-passphrase"
    pub=$(MPC_NODE_PASSPHRASE="$(cat "$DIR/secrets/node$i-passphrase")" \
      "$BIN/mpc-node" init --data-dir "$DIR/node$i")
    sign_pk=$(printf '%s' "$pub" | sed -E 's/.*"sign_pk":"([0-9a-f]+)".*/\1/')
    kx_pk=$(printf '%s' "$pub" | sed -E 's/.*"kx_pk":"([0-9a-f]+)".*/\1/')
    [ -n "$parties" ] && parties="$parties,"
    parties="$parties
    {\"id\": $i, \"url\": \"http://127.0.0.1:$((7000 + i))\", \"sign_pk\": \"$sign_pk\", \"kx_pk\": \"$kx_pk\"}"
  done
  cat > "$DIR/cluster.json" <<EOF
{
  "threshold": 2,
  "parties": [$parties
  ],
  "policy": {
    "chain_id": $CHAIN_ID,
    "max_value_wei": "1000000000000000000000",
    "max_gas": 30000000,
    "allowed_to": [],
    "deny_contract_creation": false
  }
}
EOF
  umask 022
  chmod 644 "$DIR/cluster.json"
  log "initialised $DIR (cluster.json, 3 node identities, tokens in secrets/)"
}

start() {
  [ -f "$DIR/cluster.json" ] || init
  for i in $(seq 0 $((N - 1))); do
    MPC_NODE_PASSPHRASE="$(cat "$DIR/secrets/node$i-passphrase")" \
    MPC_NODE_TOKEN="$(cat "$DIR/secrets/node-token")" \
    RUST_LOG="${RUST_LOG:-info}" \
      nohup "$BIN/mpc-node" run --data-dir "$DIR/node$i" --cluster "$DIR/cluster.json" --id "$i" \
        --listen "127.0.0.1:$((7000 + i))" --compute-threads "$COMPUTE_THREADS" \
        > "$DIR/logs/node$i.log" 2>&1 &
    echo $! > "$DIR/node$i.pid"
  done
  MPC_NODE_TOKEN="$(cat "$DIR/secrets/node-token")" \
  MPC_ADMIN_TOKEN="$(cat "$DIR/secrets/admin-token")" \
  RUST_LOG="${RUST_LOG:-info}" \
    nohup "$BIN/mpc-coordinator" --cluster "$DIR/cluster.json" --listen "0.0.0.0:$COORD_PORT" \
      --relay-url "ws://127.0.0.1:$COORD_PORT/relay" --besu-rpc "$BESU_RPC" \
      --pool-target "$POOL_TARGET" --refill-concurrency "$REFILL_CONCURRENCY" \
      > "$DIR/logs/coordinator.log" 2>&1 &
  echo $! > "$DIR/coordinator.pid"
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$COORD_PORT/health" >/dev/null && break
    sleep 0.2
  done
  log "started: coordinator http://127.0.0.1:$COORD_PORT (logs in $DIR/logs)"
}

admin() { # METHOD PATH [BODY]
  curl -sS -X "$1" "http://127.0.0.1:$COORD_PORT$2" \
    -H "Authorization: Bearer $(cat "$DIR/secrets/admin-token")" \
    -H 'Content-Type: application/json' ${3:+--data "$3"}
}

setup() {
  log "aux info generation (safe primes + ZK proofs; takes a while, once per cluster)"
  admin POST /admin/aux; echo
  if [ "$(admin GET /admin/keys)" = "[]" ]; then
    log "distributed key generation"
    admin POST /admin/keys; echo
  fi
  log "keys:"; admin GET /admin/keys; echo
}

stop() {
  for f in "$DIR"/*.pid; do
    [ -f "$f" ] || continue
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
  log "stopped"
}

case "${1:-}" in
  init) init ;;
  start) start ;;
  setup) setup ;;
  stop) stop ;;
  admin) shift; admin "$@"; echo ;;
  *) echo "usage: $0 init|start|setup|stop|admin METHOD PATH [BODY]"; exit 1 ;;
esac
