# ============================================================================
#  kore — AI API Key Delivery Network
#  https://github.com/Yorkian/kore
# ============================================================================

# Stage 1: Build frontend
FROM node:20-slim AS frontend-build
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npx vite build

# Stage 2: Build backend + compile native modules
FROM node:20-slim AS backend-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc
# Rebuild production-only node_modules with native modules compiled
RUN rm -rf node_modules && npm ci --omit=dev

# Stage 3: Minimal production image
FROM node:20-slim

LABEL org.opencontainers.image.title="kore" \
      org.opencontainers.image.description="AI API Key Delivery Network — Self-hosted AI API gateway with provider failover, load balancing, and usage quotas" \
      org.opencontainers.image.url="https://github.com/Yorkian/kore" \
      org.opencontainers.image.source="https://github.com/Yorkian/kore" \
      org.opencontainers.image.documentation="https://github.com/Yorkian/kore#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Yorkian"

# curl only — for healthcheck and provider testing
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && update-ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy pre-compiled node_modules (includes better-sqlite3 native binary)
COPY --from=backend-build /build/node_modules ./node_modules
COPY --from=backend-build /build/dist ./dist
COPY --from=frontend-build /build/frontend/dist ./frontend/dist
COPY setup-keys.js ./

RUN mkdir -p /app/data

ENV NODE_ENV=production \
    PORT=3060 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/kore.db

EXPOSE 3060

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3060/api/auth/status || exit 1

CMD ["node", "dist/index.js"]
