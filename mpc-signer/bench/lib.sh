# Shared helpers for the benchmark scripts (sourced, not executed).
#
# Node.js: uses the host's `node` if present, otherwise runs the official Node image
# (so the benchmark only needs Docker). Force the container with BENCH_NODE_DOCKER=1.

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MPC_ROOT="$(cd "$BENCH_DIR/.." && pwd)"
NODE_IMAGE="${NODE_IMAGE:-node:22-bookworm-slim}"

# Pass the host's proxy settings and extra CA (corporate proxies) into the Node container.
_node_docker_args() {
  local v
  for v in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do
    [ -n "${!v:-}" ] && printf -- '-e\n%s\n' "$v"
  done
  if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ -r "$NODE_EXTRA_CA_CERTS" ]; then
    printf -- '-v\n%s:/etc/extra-ca.crt:ro\n-e\nNODE_EXTRA_CA_CERTS=/etc/extra-ca.crt\n' "$NODE_EXTRA_CA_CERTS"
  fi
}

_use_host_node() { [ "${BENCH_NODE_DOCKER:-0}" != 1 ] && command -v node >/dev/null 2>&1; }

# nodejs ARGS...  — like `node ARGS...`; stdin is passed through
nodejs() {
  if _use_host_node; then
    node "$@"
  else
    local extra; mapfile -t extra < <(_node_docker_args)
    docker run --rm -i --network host -u "$(id -u):$(id -g)" "${extra[@]}" \
      -v "$MPC_ROOT":"$MPC_ROOT" -w "$PWD" "$NODE_IMAGE" node "$@"
  fi
}

# install the load generator's dependencies (ethers) once
bench_deps() {
  [ -d "$BENCH_DIR/node_modules/ethers" ] && return 0
  if _use_host_node; then
    (cd "$BENCH_DIR" && npm ci --silent)
  else
    local extra; mapfile -t extra < <(_node_docker_args)
    docker run --rm --network host -u "$(id -u):$(id -g)" -e npm_config_cache=/tmp/.npm "${extra[@]}" \
      -v "$MPC_ROOT":"$MPC_ROOT" -w "$BENCH_DIR" "$NODE_IMAGE" npm ci --no-audit --no-fund
  fi
}
