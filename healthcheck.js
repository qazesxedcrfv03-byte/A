'use strict';
/*
 * server/healthcheck.js — Container health check.
 *
 * Probes all three in-container services (static frontend, evidence storage,
 * attendance API) via their /health or / endpoint. Exits 0 if all healthy,
 * non-zero if any is unreachable or returns an error status.
 *
 * Uses only Node built-ins — no npm packages required.
 *
 * Env vars:
 *   STATIC_PORT (default 8080)
 *   EVIDENCE_PORT (default 3030)
 *   ATTENDANCE_PORT (default 3031)
 *   HTTPS_ENABLED  — "true" when the static frontend is served over HTTPS;
 *     the healthcheck then uses the https module for that probe (backend
 *     services remain HTTP since TLS termination is handled by Caddy/the
 *     static server's built-in proxy).
 */
const http = require('http');
const https = require('https');

const HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';

const services = [
  { name: 'static-frontend',  port: Number(process.env.STATIC_PORT || 8080),  path: '/', useHttps: HTTPS_ENABLED },
  { name: 'evidence-storage', port: Number(process.env.EVIDENCE_PORT || 3030),  path: '/health', useHttps: false },
  { name: 'attendance-api',   port: Number(process.env.ATTENDANCE_PORT || 3031), path: '/health', useHttps: false },
];

let pending = services.length;
let allHealthy = true;

services.forEach((svc) => {
  const mod = svc.useHttps ? https : http;
  const opts = {
    hostname: '127.0.0.1',
    port: svc.port,
    path: svc.path,
    method: 'GET',
    timeout: 3000,
    rejectUnauthorized: false,
  };
  const req = mod.request(opts, (res) => {
    if (res.statusCode >= 400) {
      console.error('[' + svc.name + '] unhealthy: HTTP ' + res.statusCode);
      allHealthy = false;
    }
    res.resume();
    if (--pending === 0) {
      process.exit(allHealthy ? 0 : 1);
    }
  });
  req.on('error', (err) => {
    console.error('[' + svc.name + '] unreachable on port ' + svc.port + ': ' + err.message);
    allHealthy = false;
    if (--pending === 0) {
      process.exit(allHealthy ? 0 : 1);
    }
  });
  req.on('timeout', () => {
    console.error('[' + svc.name + '] timeout on port ' + svc.port);
    req.destroy();
    allHealthy = false;
    if (--pending === 0) {
      process.exit(allHealthy ? 0 : 1);
    }
  });
  req.end();
});
