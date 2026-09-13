# ─────────────────────────────────────────────────────────
# Dockerfile for can-attendance (Node.js SPA + backend services)
#
# Application layout at source root:
#   - Frontend files (index.html, app.js, style.css, etc.) at project root
#   - Backend scripts (start.js, static-server.js, storage-service.js,
#     attendance-service.js, healthcheck.js) also at project root
#
# The backend scripts are written to run inside a server/ subdirectory:
#   start.js uses  path.join(__dirname, '..')  as ROOT and spawns
#   server/<script>.js.  This Dockerfile reorganizes them into server/
#   to match that expectation.
#
# No npm dependencies are required (zero deps in package.json).
# The frontend loads face-api.js from a CDN (jsdelivr) at runtime.
# ─────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Create a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy all application files (frontend + backend scripts + assets)
COPY --chown=appuser:appgroup . .

# Reorganize: backend scripts expect to live in server/ (start.js uses
# path.join(__dirname, '..') as ROOT and references server/<script>.js).
RUN mkdir -p server && \
    mv start.js \
       static-server.js \
       storage-service.js \
       attendance-service.js \
       healthcheck.js \
       build.js \
       lint.js \
       generate-cert.js \
       supabase-client.js \
       supabase-store.js \
       server/

# Pre-create runtime data directories (gitignored; volume-mountable for persistence)
#   server/data/            — JSON file databases (attendance, leaves, classes, etc.)
#   server/storage/evidence — evidence images (face-capture still frames)
#   server/storage/certs    — (optional) self-signed TLS certs for local HTTPS
# Install openssl for optional self-signed cert generation (HTTPS_ENABLED=true).
# In Docker compose, HTTPS is handled by the Caddy reverse proxy (no openssl needed).
RUN apk add --no-cache openssl && \
    mkdir -p server/data server/storage/evidence server/storage/certs && \
    chown -R appuser:appgroup server

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
