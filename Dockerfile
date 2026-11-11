# The server, for Railway (or any Docker host). Keep data/ on a volume: the database, recordings and backups live there.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DB_FILE=/app/data/dispatch.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY web ./web
COPY scripts ./scripts
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "--no-warnings", "src/server.js"]
