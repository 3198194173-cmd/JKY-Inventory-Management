ARG NODE_IMAGE=mirror.ccs.tencentyun.com/library/node:24.14.0-bookworm-slim
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build:ubuntu

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 INVENTORY_DB_PATH=/app/storage/inventory.sqlite
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
COPY --from=builder --chown=node:node /app/build-node ./build-node
COPY --from=builder --chown=node:node /app/scripts/server-config.mjs ./scripts/server-config.mjs
COPY --from=builder --chown=node:node /app/scripts/backup.mjs ./scripts/backup.mjs
COPY --from=builder --chown=node:node /app/scripts/dingtalk-stream.mjs ./scripts/dingtalk-stream.mjs
COPY --from=builder --chown=node:node /app/lib/sqlite.mjs ./lib/sqlite.mjs
COPY --from=builder --chown=node:node /app/scripts/import-legacy-snapshot.mjs ./scripts/import-legacy-snapshot.mjs
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 3000
CMD ["node", "server.js"]
