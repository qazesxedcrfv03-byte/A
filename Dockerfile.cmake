# ─────────────────────────────────────────────────────────
# Stage 1: Builder — install dependencies, validate code
# ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first (leverages Docker layer caching)
COPY package.json package-lock.json ./

# Install dependencies (zero npm deps in this project, but validates package.json)
RUN npm ci

# Copy all source code
COPY --chown=node:node . .

# Validate: syntax check all JS files + verify required assets present
RUN npm run lint && npm run build

# ─────────────────────────────────────────────────────────
# Stage 2: Runtime — serve frontend + run backend services
# ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Create a non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy validated source and installed dependencies from builder
COPY --from=builder --chown=appuser:appgroup /app /app

# Pre-create runtime data directories (gitignored; populated at runtime
# so they can be volume-mounted for persistence)
RUN mkdir -p /app/server/data /app/server/storage/evidence && \
    chown -R appuser:appgroup /app/server/data /app/server/storage

# Exposed ports:
#   8080 — Static frontend (index.html, JS, CSS, images)
#   3030 — Evidence storage API  (server/storage-service.js)
#   3031 — Attendance API        (server/attendance-service.js)
EXPOSE 8080 3030 3031

ENV NODE_ENV=production

USER appuser

# start.js spawns: static-server (8080), evidence-storage (3030),
# and attendance-service (3031) as child processes with graceful shutdown.
CMD ["node", "server/start.js"]
