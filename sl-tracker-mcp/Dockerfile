# MCP-сервер SL Tracker. Ожидает переменные окружения из infra/compose/docker-compose.prod.yml
# (профиль `mcp`): SL_API_URL, SL_API_TOKEN, SL_MCP_TOKEN, PORT и остальные —
# полный список в .env.example и README.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# wget есть в busybox: им же пользуется healthcheck в compose.
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=6 --start-period=10s \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/index.js"]
