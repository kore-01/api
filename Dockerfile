# ============================================================================
#  AKDN — AI API Key Delivery Network
#  Dockerfile
#  https://github.com/Yorkian/AKDN
# ============================================================================

# Stage 1: Build frontend
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npx vite build

# Stage 2: Build backend
FROM node:20-slim AS backend-build
RUN apt-get update && apt-get install -y python3 build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Stage 3: Production
FROM node:20-slim
RUN apt-get update && apt-get install -y curl python3 build-essential && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies (need build tools for better-sqlite3)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built artifacts
COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Copy runtime files
COPY ecosystem.config.js setup-keys.js .env.example ./

# Create data directory
RUN mkdir -p /app/data

# Environment
ENV NODE_ENV=production
ENV PORT=3060
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/akdn.db

EXPOSE 3060

VOLUME ["/app/data"]

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3060/api/auth/status || exit 1

# Start
CMD ["node", "dist/index.js"]
