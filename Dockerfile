# Schottr – Produktionsimage
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY assets ./assets
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "src/server.ts"]
