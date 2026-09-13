'use strict';
/*
 * server/start.js — Production/Dev orchestrator.
 *
 * Runs all services as child processes:
 *   - server/static-server.js      (frontend SPA,  port STATIC_PORT || 8080)
 *   - server/storage-service.js    (evidence storage, port EVIDENCE_PORT || 3030)
 *   - server/attendance-service.js (attendance API, port ATTENDANCE_PORT || 3031)
 *
 * All services use only Node built-ins and read their configuration from
 * environment variables (see .env.example). This script simply launches them
 * concurrently and forwards signals for graceful shutdown.
 *
 * `npm start` and `npm run dev` both invoke this file.
 *
 * HTTPS (STEP 12):
 *   Set HTTPS_ENABLED=true in .env to serve the static frontend over HTTPS.
 *   The static server auto-generates a self-signed dev certificate (requires
 *   openssl) when HTTPS_KEY_PATH / HTTPS_CERT_PATH are not set.
 *   For production HTTPS, use Docker Compose with Caddy (REVERSE_PROXY=true):
 *     docker compose up
 *   Caddy auto-provisions Let's Encrypt certificates.
 */
const { spawn } = require('child_process');
const path = require('path');

// Works two ways:
//  - Local/flat layout (this zip, no Docker): start.js sits next to the other
//    backend scripts at the project root -> ROOT = __dirname, no "server/" prefix.
//  - Docker layout: the Dockerfile moves the backend scripts into server/,
//    so start.js runs from inside server/ -> ROOT = parent dir, scripts keep
//    the "server/" prefix (same convention as lint.js's IN_SERVER check).
const IN_SERVER = path.basename(__dirname) === 'server';
const ROOT = IN_SERVER ? path.join(__dirname, '..') : __dirname;
const PREFIX = IN_SERVER ? 'server/' : '';
const SERVICES = [
  { name: 'static-server',     script: PREFIX + 'static-server.js' },
  { name: 'evidence-storage',  script: PREFIX + 'storage-service.js' },
  { name: 'attendance-service', script: PREFIX + 'attendance-service.js' },
];

const children = [];
let shuttingDown = false;

function startService(svc) {
  const child = spawn(process.execPath, [svc.script], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  child.svcName = svc.name;
  children.push(child);

  child.on('exit', (code, signal) => {
    if (!shuttingDown && code !== 0) {
      const sig = signal ? ' (' + signal + ')' : '';
      console.error('[' + svc.name + '] exited with code ' + code + sig);
    }
  });

  child.on('error', (err) => {
    console.error('[' + svc.name + '] failed to start:', err.message);
  });

  return child;
}

SERVICES.forEach(startService);

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  children.forEach((c) => {
    try { c.kill('SIGTERM'); } catch (e) { /* ignore */ }
  });
  setTimeout(() => {
    children.forEach((c) => {
      try { c.kill('SIGKILL'); } catch (e) { /* ignore */ }
    });
    process.exit(0);
  }, 3000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
