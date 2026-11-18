# Sourced by the backup scripts: record the result of a backup for monitoring.
# Writes $BACKUP_METRICS_DIR/backup-<kind>-<node>.prom (Prometheus text format), which
# node-exporter's textfile collector publishes (monitoring/node-exporter). Prometheus then alerts
# when a backup is too old, missing or failed (monitoring/prometheus/rules/backups.yml).
#   backup_metric <kind> <node> success|failure [size_bytes] [block]
BACKUP_METRICS_DIR="${BACKUP_METRICS_DIR:-/var/lib/node_exporter/textfile}"

backup_metric() {
  local kind=$1 node=$2 result=$3 size=${4:-} block=${5:-}
  local file="$BACKUP_METRICS_DIR/backup-${kind}-${node}.prom" now success=0 failure=0 old_size=0 old_block=0
  mkdir -p "$BACKUP_METRICS_DIR" 2>/dev/null || { echo "note: cannot write $BACKUP_METRICS_DIR (backup monitoring)" >&2; return 0; }
  now=$(date +%s)
  if [ -f "$file" ]; then
    success=$(awk '/^backup_last_success_timestamp_seconds/ {print $2}' "$file"); success=${success:-0}
    failure=$(awk '/^backup_last_failure_timestamp_seconds/ {print $2}' "$file"); failure=${failure:-0}
    old_size=$(awk '/^backup_last_size_bytes/ {print $2}' "$file"); old_size=${old_size:-0}
    old_block=$(awk '/^backup_last_block/ {print $2}' "$file"); old_block=${old_block:-0}
  fi
  if [ "$result" = success ]; then
    success=$now; size=${size:-$old_size}; block=${block:-$old_block}
  else
    failure=$now; size=$old_size; block=$old_block
  fi
  local l="kind=\"$kind\",node=\"$node\""
  cat > "$file.tmp" <<EOF
# HELP backup_last_success_timestamp_seconds Unix time of the last successful backup.
# TYPE backup_last_success_timestamp_seconds gauge
backup_last_success_timestamp_seconds{$l} $success
# HELP backup_last_failure_timestamp_seconds Unix time of the last failed backup (0 = never).
# TYPE backup_last_failure_timestamp_seconds gauge
backup_last_failure_timestamp_seconds{$l} $failure
# HELP backup_last_size_bytes Size of the last successful backup.
# TYPE backup_last_size_bytes gauge
backup_last_size_bytes{$l} ${size:-0}
# HELP backup_last_block Chain height in the last successful chain snapshot (0 for other kinds).
# TYPE backup_last_block gauge
backup_last_block{$l} ${block:-0}
EOF
  chmod 644 "$file.tmp" && mv "$file.tmp" "$file"
}
