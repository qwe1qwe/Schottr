# Schottr – Produktionsimage
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    SCHOTTR_DOCKER=1 \
    SCHOTTR_DATA_DIR=/app/data
RUN apk add --no-cache su-exec
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY assets ./assets
COPY docker-entrypoint.sh /usr/local/bin/schottr-entrypoint
# Dateiablage (Nachweise, Eingangsrechnungen, Belegeingang) – in compose.yml als Volumes einbinden
RUN chmod 755 /usr/local/bin/schottr-entrypoint \
 && mkdir -p /app/data/nachweise /app/data/verbindlichkeiten /app/data/other \
 && chown -R node:node /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
# Der Entrypoint gibt die Rechte an der Dateiablage an "node" und startet die App als "node"
ENTRYPOINT ["/usr/local/bin/schottr-entrypoint"]
CMD ["node", "src/server.ts"]
