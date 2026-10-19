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
ARG DEBIAN_MIRROR=https://mirrors.cloud.tencent.com/debian
ARG DEBIAN_SECURITY_MIRROR=http://security.debian.org/debian-security
# Slim images may not have system CA files. Use Node's public trust roots for
# this HTTPS APT step; keep Debian's existing repository signature verification.
RUN set -eu; \
    node -e "require('node:fs').writeFileSync('/tmp/jky-apt-ca.pem', require('node:tls').rootCertificates.join('\n') + '\n')"; \
    for sources in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do \
      if [ -f "$sources" ]; then \
        sed -i \
          -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
          -e "s|https://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
          -e "s|http://security.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
          -e "s|https://security.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
          -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
          -e "s|https://deb.debian.org/debian|${DEBIAN_MIRROR}|g" "$sources"; \
      fi; \
    done; \
    printf '%s\n' 'Acquire::Retries "2";' 'Acquire::http::Timeout "20";' 'Acquire::https::Timeout "20";' 'Acquire::https::CaInfo "/tmp/jky-apt-ca.pem";' 'APT::Update::Error-Mode "any";' > /etc/apt/apt.conf.d/80jky-build-network; \
    timeout --kill-after=10s 300s sh -ec 'apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk' || { result=$?; echo 'Chinese font installation failed or exceeded 300 seconds. Check the APT mirror/network before retrying.' >&2; exit "$result"; }; \
    rm -rf /var/lib/apt/lists/*; \
    rm -f /etc/apt/apt.conf.d/80jky-build-network /tmp/jky-apt-ca.pem
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
