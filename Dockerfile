# ---- build stage: install all deps, compile server + web ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server server
COPY web web
COPY seed seed
COPY config config
RUN npm ci --no-audit --no-fund
RUN npm run build

# ---- runtime stage: prod deps only + ffmpeg for speaking uploads ----
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files for workspace production install
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

# Install ONLY production dependencies for workspaces
RUN npm ci --omit=dev --no-audit --no-fund

# Copy built artifacts and seed data from the build stage
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/seed ./seed
COPY --from=build /app/config ./config

EXPOSE 8787
CMD ["node", "server/dist/index.js"]