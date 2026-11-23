#!/bin/bash
# Copies the memo module (memo/) into the apps that use it; memo/test.js checks the copies.
set -euo pipefail
cd "$(dirname "$0")/.."
for app in proxy chainlens gateway; do
  mkdir -p "$app/memo"
  cp memo/memo.js memo/memo-types.json "$app/memo/"
done
echo "memo/ copied to proxy/memo, chainlens/memo, gateway/memo"
