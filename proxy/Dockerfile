FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R node:node /app

COPY --chown=node:node stress-latest.js nft-collection.json ./

USER node

ENV NODE_ENV=production
ENV LISTEN_HOST=0.0.0.0
ENV BESU_IP=""
ENV VAULT_IP=""
ENV WEB3SIGNER_IP=""
ENV SENDER01=""

EXPOSE 30000

CMD ["node", "stress-latest.js"]
