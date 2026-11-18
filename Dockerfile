# ==============================================================================
# AtelierSync Multi-Stage & Multi-Arch Dockerfile (Linux ARM64 / x86_64)
# Lightweight, single-container production distribution for NAS, Raspberry Pi & Cloud VPS
# ==============================================================================

# Stage 1: Build stage
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /build

# Install build dependencies for native compilation (better-sqlite3, etc.)
RUN apk add --no-cache python3 make g++ git
RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

# Copy monorepo configuration files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/client/package.json ./apps/client/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source trees
COPY packages/ ./packages/
COPY apps/ ./apps/

# Compile Shared package, Client SPA, and Server
RUN pnpm --filter @atelier/shared build
RUN pnpm --filter @atelier/client build
RUN pnpm --filter @atelier/server build

# ==============================================================================
# Stage 2: Production Runner image (Multi-Arch: linux/amd64, linux/arm64)
# ==============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

# Minimal production runtime tools
RUN apk add --no-cache tzdata curl wget
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
# The server reads DATA_DIR (atelier.db + snapshots/ inside it). Without it, data was written to
# /app/apps/server/data inside the container and lost on every rebuild instead of landing on the volume.
ENV DATA_DIR=/app/data

# Create persistent storage directories
RUN mkdir -p /app/data /app/data/snapshots

# Copy dependencies & artifacts
COPY --from=builder /build/package.json /build/pnpm-workspace.yaml ./
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages/shared ./packages/shared
COPY --from=builder /build/apps/server/package.json ./apps/server/package.json
COPY --from=builder /build/apps/server/dist ./apps/server/dist
COPY --from=builder /build/apps/server/node_modules ./apps/server/node_modules

# Copy compiled client static files
COPY --from=builder /build/apps/client/dist ./apps/client/dist

# Expose HTTP / WebSocket port
EXPOSE 3000

# Mount persistent data volume
VOLUME ["/app/data"]

# Health check probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Start server
CMD ["node", "apps/server/dist/server.js"]
