FROM node:24-bookworm-slim

LABEL io.harness-rsi.model-gateway="v1"

WORKDIR /app
COPY docker/model-gateway/server.mjs /app/server.mjs
RUN chmod 0444 /app/server.mjs

USER node
EXPOSE 8080
HEALTHCHECK --interval=1s --timeout=2s --start-period=2s --retries=30 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/server.mjs"]
