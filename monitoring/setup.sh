#!/usr/bin/env bash
# One-time setup of the monitoring host:
#   - .env from .env.example with a random Grafana admin password (printed once)
#   - secrets/mpc-metrics-token (Prometheus refuses to start if this file is missing)
#       ./setup.sh                         token file empty (coordinator without MPC_METRICS_TOKEN)
#       MPC_METRICS_TOKEN=<token> ./setup.sh   same value as the coordinator's MPC_METRICS_TOKEN
# Safe to run again: it never overwrites .env, and only writes the token when one is given.
set -Eeuo pipefail
cd "$(dirname "$0")"
umask 077

if [ ! -f .env ]; then
  pw=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-24)
  sed "s|^GRAFANA_ADMIN_PASSWORD=.*|GRAFANA_ADMIN_PASSWORD=$pw|" .env.example > .env
  echo "created .env - Grafana login: admin / $pw"
  echo "set BIND_IP in .env to one of this host's IPs: $(hostname -I 2>/dev/null)"
else
  echo ".env exists, left unchanged"
fi

mkdir -p secrets
if [ -n "${MPC_METRICS_TOKEN:-}" ]; then
  printf '%s' "$MPC_METRICS_TOKEN" > secrets/mpc-metrics-token
  echo "wrote secrets/mpc-metrics-token"
elif [ ! -f secrets/mpc-metrics-token ]; then
  : > secrets/mpc-metrics-token
  echo "created an empty secrets/mpc-metrics-token (set MPC_METRICS_TOKEN=... ./setup.sh to fill it)"
fi
# Prometheus runs as user nobody (65534) in its container: it must be able to read the token file.
# Protect it with the host's permissions on this directory's parent / the host itself.
chmod 755 secrets
chmod 644 secrets/mpc-metrics-token

echo "next: edit prometheus/targets/*.yml, then: docker compose up -d"
