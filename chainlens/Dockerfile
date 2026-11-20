FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# Offline: when offline/npm-cache.tgz is in the build context (made by offline/make-offline.sh), the
# packages come from that npm cache only, without network; otherwise from the npm registry.
# The bind mount keeps the archive out of the image.
RUN --mount=type=bind,source=offline,target=/offline \
    if [ -f /offline/npm-cache.tgz ]; then \
      mkdir -p /tmp/npm-cache && tar -xzf /offline/npm-cache.tgz -C /tmp/npm-cache \
      && npm ci --omit=dev --offline --no-audit --no-fund --cache /tmp/npm-cache && rm -rf /tmp/npm-cache; \
    else npm ci --omit=dev; fi \
    && npm cache clean --force && chown -R node:node /app

COPY --chown=node:node server.js deploy.js ./
COPY --chown=node:node public ./public

USER node

ENV NODE_ENV=production
ENV LISTEN_HOST=0.0.0.0
ENV PORT=30100
# Besu JSON-RPC to index (set at runtime)
ENV BESU_RPC=""

EXPOSE 30100

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/status" >/dev/null || exit 1

CMD ["node", "server.js"]
