# Optimistic section gateway (docs/components/gateway.md). No npm packages: Node's own http and sqlite.
FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node gateway.js ./
COPY --chown=node:node memo ./memo
USER node
EXPOSE 30010
CMD ["node", "--no-warnings", "gateway.js"]
