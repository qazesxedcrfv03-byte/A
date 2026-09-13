# Domain Deployment Audit & Traffic Map

## Project: Nong Can AI Attendance

**Date:** 2026-09-13
**Status:** Audited, critical bug fixed, ready for deployment

---

## Architecture Summary

A browser-based facial attendance PWA with a Dockerized single-container app (Caddy + Node.js) or Cloudflare Tunnel deployment.

### Traffic Map

```
[BROWSER]
  |  1. GET https://your-domain.com/
  v
[CADDY REVERSE PROXY]  (ports 80/443 published; TLS via Let's Encrypt or tunnel)
  |  2. GET http://app:8080/  (internal)
  v
[STATIC-SERVER.JS]  (port 8080, Node.js built-ins, HTTPS step 12)
  |  3. Serves index.html, app.js, sw.js, manifest.json
  |  Browser loads /runtime-config.js (injected dynamically)
  |      -> REVERSE_PROXY=true → relative URLs (/api/evidence, /api/*)
  v
[BROWSER] — same-origin through Caddy

[BROWSER]
  |  4. POST https://your-domain.com/api/evidence  (camera capture → image upload)
  v
[CADDY] → reverse_proxy to app:3030
  v
[STORAGE-SERVICE.JS]  (port 3030, Bearer token auth, Supabase Storage bucket)

[BROWSER]
  |  5. GET/POST https://your-domain.com/api/attendance, /api/scans, etc.
  v
[CADDY] → reverse_proxy to app:3031
  v
[ATTENDANCE-SERVICE.JS]  (port 3031, Bearer token auth, Supabase DB)
```

### Cloudflare Tunnel Path (no domain, no port forwarding)

```
[INTERNET]
  |  HTTPS (Cloudflare edge terminates TLS)
  v
[cloudflared container]  (docker-compose.tunnel.yml)
  |  command: tunnel --url http://caddy:80
  v
[CADDY:80]  (Caddyfile.tunnel — HTTP only, no TLS)
  |  reverse_proxy to app:8080 / app:3030 / app:3031
  v
[APP CONTAINER]  (static-server, storage-service, attendance-service)
```

---

## Files Inventory

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Direct deployment: Caddy with Let's Encrypt TLS (ports 80/443 published) |
| `docker-compose.tunnel.yml` | Cloudflare Tunnel deployment: Caddy HTTP-only + cloudflared |
| `docker-compose.ngrok.yml` | Ngrok tunnel deployment (if used) |
| `Dockerfile` | Multi-stage build: npm install → static-server + backend |
| `Caddyfile` | HTTPS reverse proxy config (domain + ACME + TLS) |
| `Caddyfile.tunnel` | HTTP-only reverse proxy config (behind tunnel, no TLS) |
| `start.js` | Orchestrator: spawns static-server, storage-service, attendance-service |
| `static-server.js` | Static file server (port 8080) + API reverse proxy + security headers |
| `storage-service.js` | Evidence image upload/retrieval API (port 3030) |
| `attendance-service.js` | Attendance management API (port 3031) |
| `healthcheck.js` | Container health check |
| `app.js` | Frontend SPA logic (camera, face detection via face-api.js) |
| `scan.js` | Face scanning logic |
| `evidence.js` | Evidence upload to /api/evidence |
| `manifest.json` | PWA manifest |
| `sw.js` | PWA service worker |
| `.env.example` | Environment variable template |
| `.env` | Runtime environment (created, with generated tokens) |
| `lint.js` | Linting script (17 JS files) |

---

## Critical Issues Found & Fixed

### 1. Permissions-Policy blocking camera access (CRITICAL — BROKEN)

**`camera=()`** in the `Permissions-Policy` header blocks all camera access, breaking `getUserMedia()` for face scanning. This existed in **4 files**:

| File | Line | Before | After |
|------|------|--------|-------|
| `Caddyfile` | 37 | `Permissions-Policy "camera=(), ..."` | `Permissions-Policy "camera=self, ..."` |
| `Caddyfile.tunnel` | 17 | `Permissions-Policy "camera=(), ..."` | `Permissions-Policy "camera=self, ..."` |
| `static-server.js` | 76 | `'Permissions-Policy': 'camera=(), ...'` | `'Permissions-Policy': 'camera=self, ...'` |
| `storage-service.js` | 55 | `'Permissions-Policy': 'camera=(), ...'` | `'Permissions-Policy': 'camera=self, ...'` |
| `attendance-service.js` | 65 | `'Permissions-Policy': 'camera=(), ...'` | `'Permissions-Policy': 'camera=self, ...'` |

`microphone`, `geolocation`, and `payment` remain disabled (`()`) as intended.

---

## Environment Configuration

### `.env` file

Created from `.env.example` with:
- **EVIDENCE_ADMIN_TOKEN** and **ATTENDANCE_ADMIN_TOKEN**: Generated 32-char random tokens
- **REVERSE_PROXY**: `true` (matches compose file override)
- **HTTPS_ENABLED**: `false` (Caddy handles TLS)
- **CADDY_DOMAIN**: `localhost` (update to real domain for `docker-compose.yml` direct deployment)
- **SUPABASE_URL** / **SUPABASE_SERVICE_ROLE_KEY**: Empty — must be filled with real credentials

### Deployment commands

**Direct (needs real domain + port forwarding):**
```bash
docker compose up -d --build
# Caddy auto-provisions Let's Encrypt cert for CADDY_DOMAIN
```

**Cloudflare Tunnel (no domain, no port forwarding):**
```bash
docker compose -f docker-compose.tunnel.yml up -d --build
# Get URL from logs: docker compose -f docker-compose.tunnel.yml logs -f cloudflared
```

---

## Validation Results

| Check | Result |
|-------|--------|
| `node lint.js` | Passed (17 JavaScript files) |
| `docker compose config` | Passed |
| `docker compose -f docker-compose.tunnel.yml config` | Passed |
| Camera Permissions-Policy fix | Applied to all 5 files |

---

## Next Steps for Deployment

1. **Fill in `.env`**: Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from your Supabase project
2. **Deploy**: `docker compose -f docker-compose.tunnel.yml up -d --build`
3. **Get tunnel URL**: `docker compose -f docker-compose.tunnel.yml logs -f cloudflared`
4. **Update CADDY_EMAIL** in `.env` to a real email if using direct deployment with Let's Encrypt

---

## Notes

- The static server (`static-server.js`) serves only whitelisted file types from project root. It blocks access to `/server/`, hidden files, package files, and sensitive JSON files (only `manifest.json` is served as JSON).
- The runtime-config.js is injected dynamically by static-server.js at request time — it sets `window.__RUNTIME_CONFIG__` with API URLs and admin tokens based on `REVERSE_PROXY` mode.
- All three services (ports 8080/3030/3031) are `expose`d internally only — never published to the host. Caddy is the sole entry point.
- The `start.js` orchestrator detects whether it's running from `server/` (Docker layout) or project root (local dev) and adjusts paths accordingly.
