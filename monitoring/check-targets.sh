#!/usr/bin/env bash
# Test every metrics endpoint listed in prometheus/targets/*.yml from THIS host (run it on the
# monitoring host, so the firewall path is the same as Prometheus'). Prints one line per target:
#   OK / 403 / 401 / 404 / unreachable, with the likely cause.
#   ./check-targets.sh
# Exit code: 0 if every target answers 200, 1 otherwise.
set -uo pipefail
cd "$(dirname "$0")"
token=""
[ -s secrets/mpc-metrics-token ] && token=$(cat secrets/mpc-metrics-token)
fail=0

hint() {
  case "$1:$2" in
    besu:403) echo "Besu refuses the Host header: old node package, copy the new docker-compose*.yml and ./start.sh" ;;
    mpc:401)  echo "token mismatch: secrets/mpc-metrics-token != coordinator MPC_METRICS_TOKEN" ;;
    mpc:404)  echo "old coordinator image without /metrics: build/deploy the new mpc-signer image" ;;
    proxy:404) echo "old proxy without /metrics: git pull, then docker compose up -d --build in proxy/" ;;
    proxy:401) echo "the proxy has METRICS_TOKEN set: add an authorization block to the proxy job" ;;
    *:000)    echo "no answer: wrong IP/port in targets/, service down, or firewall blocks this host" ;;
    *)        echo "unexpected HTTP status" ;;
  esac
}

check() { # kind file
  local kind=$1 file=$2 t code name
  [ -f "$file" ] || return 0
  # each entry: - targets: ["ip:port"]   followed by   labels: { node|name|host: X, ... }
  while IFS='|' read -r t name; do
    if [ "$kind" = mpc ] && [ -n "$token" ]; then
      code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "http://$t/metrics")
    else
      code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$t/metrics")
    fi
    if [ "$code" = 200 ]; then
      printf '  OK   %-6s %-14s %s\n' "$kind" "$name" "$t"
    else
      printf '  FAIL %-6s %-14s %s  -> %s: %s\n' "$kind" "$name" "$t" "$code" "$(hint "$kind" "$code")"
      fail=1
    fi
  done < <(awk '
    /targets:/ { if (t != "") print t "|" n; match($0, /"[^"]+"/); t = substr($0, RSTART + 1, RLENGTH - 2); n = "" }
    /labels:/  { if (match($0, /(node|name|host): *[^,} ]+/)) { s = substr($0, RSTART, RLENGTH); sub(/^[a-z]+: */, "", s); n = s } }
    END        { if (t != "") print t "|" n }' "$file")
}

echo "Besu nodes (targets/besu.yml)";        check besu prometheus/targets/besu.yml
echo "MPC coordinators (targets/mpc.yml)";   check mpc  prometheus/targets/mpc.yml
echo "Proxy (targets/proxy.yml)";            check proxy prometheus/targets/proxy.yml
echo "Hosts / node-exporter (targets/hosts.yml)"; check host prometheus/targets/hosts.yml

# What Prometheus itself sees (needs the stack running on this host)
if curl -s -m 3 http://127.0.0.1:9090/-/ready >/dev/null 2>&1; then
  echo "Prometheus scrape status:"
  curl -s http://127.0.0.1:9090/api/v1/targets | grep -o '"health":"[a-z]*"' | sort | uniq -c | sed 's/^/ /'
fi
exit $fail
