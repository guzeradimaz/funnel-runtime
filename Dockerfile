FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/funnel.db
COPY --from=build /app /app
VOLUME /app/data
EXPOSE 3000
CMD ["npx", "tsx", "src/server/index.ts"]
