# ---- deps -------------------------------------------------------------
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production 2>/dev/null || bun install --production

# ---- runtime ----------------------------------------------------------
FROM oven/bun:1-alpine AS runtime
WORKDIR /app

# tini reaps zombies and forwards SIGTERM, so graceful shutdown actually works.
RUN apk add --no-cache tini

# --chown on each COPY rather than a trailing `RUN chown -R`: the RUN form
# rewrites every file and doubles node_modules into a second ~50MB layer.
# `bun` is a pre-existing non-root user in the base image.
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun workflows ./workflows

RUN mkdir -p /data && chown bun:bun /data
USER bun

ENV NODE_ENV=production \
    DATABASE_PATH=/data/automator.db \
    PORT=3000
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz > /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "src/index.ts"]
