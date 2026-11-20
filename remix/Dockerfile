# Self-hosted Remix IDE with a local Solidity compiler mirror: works without internet access.
# The build context needs remix-live/ (the prebuilt Remix site, branch gh-pages of
# github.com/remix-project-org/remix-live at a pinned commit; Ansible fetches it, see docs/components/remix.md).
FROM node:22-alpine AS solc
# Compiler versions offered by Remix (space-separated, each an npm "solc" version)
ARG SOLC_VERSIONS=0.8.28
WORKDIR /build
COPY make-solc-bin.js ./
# plus the version Remix selects by default (from its bundle), so it loads without a choice
COPY remix-live/main.*.js /tmp/remix-main/
# Offline: when offline/solc-npm-cache.tgz is in the context (Ansible puts it there from
# image_archives_dir; offline/make-offline.sh makes it), solc comes from that npm cache without network.
RUN --mount=type=bind,source=offline,target=/offline \
    if [ -f /offline/solc-npm-cache.tgz ]; then \
      mkdir -p /tmp/npm-cache && tar -xzf /offline/solc-npm-cache.tgz -C /tmp/npm-cache \
      && npmargs="--offline --cache /tmp/npm-cache"; \
    fi \
    && default=$(grep -o '"defaultVersion":"soljson-v[0-9.]*' /tmp/remix-main/*.js | head -1 | sed 's/.*soljson-v//') \
    && SOLC_VERSIONS=$(printf '%s\n' $SOLC_VERSIONS $default | sort -u -V | tr '\n' ' ') \
    && echo "solc versions: $SOLC_VERSIONS" \
    && for v in $SOLC_VERSIONS; do \
      npm install --silent --no-audit --no-fund $npmargs --prefix "/build/solc-$v" "solc@$v" || exit 1; \
    done && node make-solc-bin.js /out $SOLC_VERSIONS

FROM node:22-alpine
WORKDIR /app
COPY remix-live/ ./site/
COPY --from=solc /out ./site/solc-bin/
COPY serve.js ./
# Remix loads its compiler list and compilers from binaries.soliditylang.org: use the mirror instead
RUN grep -l 'https://binaries.soliditylang.org/' site/*.js | xargs -r sed -i \
      -e 's#https://binaries.soliditylang.org/bin#/solc-bin#g' \
      -e 's#https://binaries.soliditylang.org/wasm#/solc-bin#g' \
    && ! grep -l 'https://binaries.soliditylang.org/\(bin\|wasm\)"' site/*.js
USER node
EXPOSE 30200
CMD ["node", "serve.js"]
