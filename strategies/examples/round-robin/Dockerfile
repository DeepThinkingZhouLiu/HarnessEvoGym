FROM node:24-bookworm-slim

WORKDIR /app
COPY --chown=node:node --chmod=0444 strategy.mjs /app/strategy.mjs

USER node
ENTRYPOINT []
CMD ["node", "/app/strategy.mjs"]
