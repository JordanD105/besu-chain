#!/usr/bin/env bash
# Makes the archives for building the images WITHOUT internet (docs/deployment/offline-build.md).
# Run it on a machine WITH internet and Docker, from anywhere in the repository:
#
#   offline/make-offline.sh                   the package archives, inside the repository (commit them):
#                                               chainlens/offline/npm-cache.tgz   npm packages (package-lock.json)
#                                               proxy/offline/npm-cache.tgz       npm packages (package-lock.json)
#                                               docs-site/offline/wheels.tgz      Python wheels (requirements.txt)
#                                               mpc-signer/offline/cargo-vendor.tgz  Rust crates (Cargo.lock)
#   offline/make-offline.sh --remix DIR       also Remix, into DIR (image_archives_dir; too big for git):
#                                               remix-live-<remix_commit>.tgz      the Remix site
#                                               remix-solc-npm-cache.tgz           the Solidity compilers
#   offline/make-offline.sh --only proxy      one of: chainlens proxy docs-site mpc-signer
#
# The base images (node, python, nginx, rust, debian) are saved by `ansible-playbook save-images.yml`.
# Each package archive is made inside the image's own base image, so it matches the build exactly.
# Rerun after a change to package-lock.json, requirements.txt, Cargo.lock, remix_commit or
# remix_solc_versions; the build fails offline (and says what is missing) when an archive is stale.
# Extra `docker run` options, e.g. for a proxy and its CA certificate:
#   DOCKER_RUN_ARGS="--network host -e HTTPS_PROXY=http://proxy:3128 -v /etc/ca.crt:/ca.crt:ro -e SSL_CERT_FILE=/ca.crt
#                    -e NODE_EXTRA_CA_CERTS=/ca.crt -e PIP_CERT=/ca.crt -e CARGO_HTTP_CAINFO=/ca.crt"
set -Eeuo pipefail
cd "$(dirname "$0")/.."
root=$PWD
remix_dir="" only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --remix) remix_dir="${2:?--remix DIR}"; shift 2 ;;
    --only) only="${2:?--only NAME}"; shift 2 ;;
    *) sed -n '2,24p' "$0"; exit 1 ;;
  esac
done
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
# shellcheck disable=SC2086  # DOCKER_RUN_ARGS is a list of options
run() { docker run --rm ${DOCKER_RUN_ARGS:-} "$@"; }
base() { grep -m1 -oE '^FROM [^ ]+' "$1" | awk '{print $2}'; }   # the first FROM line of a Dockerfile
want() { [ -z "$only" ] || [ "$only" = "$1" ]; }
size() { du -h "$1" | cut -f1; }

npm_cache() {   # $1 = chainlens | proxy: npm ci into an empty cache, then pack the cache
  local app=$1
  echo "== $app: npm packages of package-lock.json ($(base "$app/Dockerfile"))"
  run -v "$root/$app:/app:ro" -v "$tmp:/out" "$(base "$app/Dockerfile")" sh -ec '
    mkdir /w && cd /w && cp /app/package.json /app/package-lock.json .
    npm ci --omit=dev --no-audit --no-fund --ignore-scripts --cache /tmp/cache >/dev/null
    rm -rf /tmp/cache/_logs /tmp/cache/_update-notifier-last-checked
    tar -czf /out/npm-cache.tgz -C /tmp/cache . && chmod 644 /out/npm-cache.tgz'
  mkdir -p "$app/offline" && mv "$tmp/npm-cache.tgz" "$app/offline/npm-cache.tgz"
  echo "   $app/offline/npm-cache.tgz  $(size "$app/offline/npm-cache.tgz")"
}

want chainlens && npm_cache chainlens
want proxy && npm_cache proxy

if want docs-site; then
  img=$(base docs-site/Dockerfile)
  echo "== docs-site: Python wheels of requirements.txt ($img)"
  run -v "$root/docs-site/requirements.txt:/requirements.txt:ro" -v "$tmp:/out" "$img" sh -ec '
    pip download --quiet --no-cache-dir --only-binary=:all: -r /requirements.txt -d /w
    tar -czf /out/wheels.tgz -C /w . && chmod 644 /out/wheels.tgz'
  mv "$tmp/wheels.tgz" docs-site/offline/wheels.tgz
  echo "   docs-site/offline/wheels.tgz  $(size docs-site/offline/wheels.tgz)"
fi

if want mpc-signer; then
  img=$(base mpc-signer/Dockerfile)
  echo "== mpc-signer: Rust crates of Cargo.lock ($img)"
  run -v "$root/mpc-signer:/src:ro" -v "$tmp:/out" "$img" sh -ec '
    mkdir /w && cp -r /src/Cargo.toml /src/Cargo.lock /src/src /w/ && cd /w
    cargo vendor --locked --quiet vendor >/dev/null
    tar -czf /out/cargo-vendor.tgz vendor && chmod 644 /out/cargo-vendor.tgz'
  mv "$tmp/cargo-vendor.tgz" mpc-signer/offline/cargo-vendor.tgz
  echo "   mpc-signer/offline/cargo-vendor.tgz  $(size mpc-signer/offline/cargo-vendor.tgz)"
fi

if [ -n "$remix_dir" ]; then
  setting() { python3 -c "import sys, yaml; v = yaml.safe_load(open('ansible/group_vars/all/settings.yml'))[sys.argv[1]]; print(' '.join(v) if isinstance(v, list) else v)" "$1"; }
  commit=$(setting remix_commit); repo=$(setting remix_repo); versions=$(setting remix_solc_versions)
  mkdir -p "$remix_dir"
  echo "== remix: the site at $commit"
  git -C "$tmp" init -q remix-live
  git -C "$tmp/remix-live" fetch -q --depth 1 "$repo" "$commit"
  git -C "$tmp/remix-live" checkout -q FETCH_HEAD
  tar -czf "$remix_dir/remix-live-$commit.tgz" -C "$tmp/remix-live" --exclude=.git .
  echo "   $remix_dir/remix-live-$commit.tgz  $(size "$remix_dir/remix-live-$commit.tgz")"
  # the same versions as remix/Dockerfile: remix_solc_versions plus the site's default compiler
  default=$(grep -oh '"defaultVersion":"soljson-v[0-9.]*' "$tmp"/remix-live/main.*.js | head -1 | sed 's/.*soljson-v//')
  versions=$(printf '%s\n' $versions $default | sort -u -V | tr '\n' ' ')
  echo "== remix: Solidity compilers $versions($(base remix/Dockerfile))"
  run -v "$tmp:/out" -e "VERSIONS=$versions" "$(base remix/Dockerfile)" sh -ec '
    for v in $VERSIONS; do
      npm install --silent --no-audit --no-fund --cache /tmp/cache --prefix "/w/solc-$v" "solc@$v"
    done
    rm -rf /tmp/cache/_logs /tmp/cache/_update-notifier-last-checked
    tar -czf /out/solc.tgz -C /tmp/cache . && chmod 644 /out/solc.tgz'
  mv "$tmp/solc.tgz" "$remix_dir/remix-solc-npm-cache.tgz"
  echo "   $remix_dir/remix-solc-npm-cache.tgz  $(size "$remix_dir/remix-solc-npm-cache.tgz")"
fi

# checksums of the archives in the repository
find chainlens/offline proxy/offline docs-site/offline mpc-signer/offline -name '*.tgz' | sort | xargs -r sha256sum > offline/SHA256SUMS
echo "== offline/SHA256SUMS"; cat offline/SHA256SUMS
echo "Commit the archives and offline/SHA256SUMS (git add -A chainlens/offline proxy/offline docs-site/offline mpc-signer/offline offline)."
