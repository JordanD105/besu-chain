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
    && chown -R node:node /app

COPY --chown=node:node stress-latest.js avatar-collection.json section-registry.json section-registry-v1.json nickname-collection.json ./

USER node

ENV NODE_ENV=production
ENV LISTEN_HOST=0.0.0.0
ENV BESU_IP=""
ENV SIGNER_IP=""
ENV SENDER01=""

EXPOSE 30000

CMD ["node", "stress-latest.js"]
