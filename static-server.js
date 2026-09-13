'use strict';
/*
 * server/static-server.js — Minimal static file server for the frontend SPA.
 *
 * Serves ONLY frontend assets (index.html, JS, CSS, PNG at the project root)
 * using only Node.js built-in modules (no npm dependencies).
 *
 * This is infrastructure, not application business logic. It exists because the
 * existing project is a browser SPA with no HTTP server — in Docker the static
 * frontend must be served over HTTP (file:// breaks localStorage / camera APIs).
 *
 * SECURITY: Only serves whitelisted file types from the project ROOT level.
 * Blocks access to /server/ (backend code + biometric evidence images +
 * student data), hidden files, package files, and all subdirectories that
 * could leak sensitive information.
 *
 * Env vars:
 *   STATIC_PORT (default 8080)
 *   STATIC_ROOT  (default = parent of server/, i.e. project root)
 *
 * HTTPS (STEP 12 — HTTPS/TLS everywhere):
 *   HTTPS_ENABLED   — "true" to serve the static frontend over HTTPS
 *   HTTPS_KEY_PATH  — path to TLS private key (PEM); if absent with HTTPS_ENABLED,
 *                     a self-signed dev certificate is auto-generated.
 *   HTTPS_CERT_PATH — path to TLS certificate (PEM); same auto-gen fallback.
 *   HTTPS_HSTS      — "true" (default) to emit Strict-Transport-Security on HTTPS.
 *
 * When HTTPS_ENABLED is true the server emits HSTS and security headers
 * (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy)
 * so that `window.isSecureContext` is satisfied and getUserMedia (camera) works
 * even when not on localhost.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.STATIC_PORT || 8080);
const ROOT = process.env.STATIC_ROOT || path.join(__dirname, '..');
const ROOT_RESOLVED = path.resolve(ROOT);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.txt':   'text/plain; charset=utf-8',
  '.map':   'application/json; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
};

const SERVED_EXTENSIONS = new Set(Object.keys(MIME_TYPES));

const HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';
const HTTPS_HSTS = process.env.HTTPS_HSTS !== 'false';

const PROXY = {
  evidencePort: Number(process.env.EVIDENCE_PORT || 3030),
  attendancePort: Number(process.env.ATTENDANCE_PORT || 3031),
};

function securityHeaders() {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
  if (HTTPS_ENABLED && HTTPS_HSTS) {
    h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return h;
}

function opensslAvailable() {
  try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true; }
  catch (e) { return false; }
}

function generateSelfSignedCert(outDir) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  if (!opensslAvailable()) {
    console.error('[static-server] ERROR: openssl is not available and no HTTPS_KEY_PATH/HTTPS_CERT_PATH provided.');
    console.error('[static-server] Options: install openssl, set HTTPS_KEY_PATH + HTTPS_CERT_PATH, or use Docker/Caddy (docker compose up).');
    process.exit(1);
  }
  const keyPath = path.join(outDir, 'dev-key.pem');
  const certPath = path.join(outDir, 'dev-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath, '-out', certPath, '-days', '365', '-nodes',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' });
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o644);
  console.log('[static-server] Auto-generated self-signed dev certificate (key=' + keyPath + ', cert=' + certPath + ')');
  console.log('[static-server] NOTE: Self-signed cert is for local dev only. For production, use Caddy/Let\'s Encrypt or set HTTPS_KEY_PATH/HTTPS_CERT_PATH.');
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

function loadHttpsCredentials() {
  const keyPath = process.env.HTTPS_KEY_PATH;
  const certPath = process.env.HTTPS_CERT_PATH;
  if (keyPath && certPath) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const defaultDir = path.join(ROOT_RESOLVED, 'server', 'storage', 'certs');
  return generateSelfSignedCert(defaultDir);
}

function proxyRequest(req, res, targetPort) {
  const urlObj = new URL(req.url, 'http://x');
  const options = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: urlObj.pathname + urlObj.search,
    method: req.method,
    headers: { ...req.headers, host: '127.0.0.1:' + targetPort, 'x-forwarded-proto': 'https' },
  };
  const proxyReq = http.request(options, (proxyRes) => {
    const bypassCors = true;
    res.writeHead(proxyRes.statusCode || 200, {
      ...securityHeaders(),
      'Content-Type': proxyRes.headers['content-type'] || 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': proxyRes.headers['cache-control'] || 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS,PUT,DELETE',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    });
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { ...securityHeaders(), 'Content-Type': 'text/plain' });
    if (!res.writableEnded) res.end('Bad Gateway');
  });
  req.pipe(proxyReq);
}

function isProxyRequest(urlPath) {
  if (!HTTPS_ENABLED) return false;
  if (urlPath === '/health' || urlPath.indexOf('/api/evidence') === 0 ||
      urlPath.indexOf('/api/attendance') === 0 || urlPath.indexOf('/api/audit') === 0 ||
      urlPath.indexOf('/api/stats') === 0 || urlPath.indexOf('/api/scans') === 0 ||
      urlPath.indexOf('/api/classes') === 0 || urlPath.indexOf('/api/students') === 0) {
    return true;
  }
  return false;
}

const requestHandler = (req, res) => {
  const urlObj = new URL(req.url, 'http://x');
  const urlPath = decodeURIComponent(urlObj.pathname);

  if (res.headersSent) return;

  if (HTTPS_ENABLED && (req.method === 'OPTIONS' && urlPath.indexOf('/api/') === 0)) {
    res.writeHead(204, { ...securityHeaders(), 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS,PUT,DELETE', 'Access-Control-Allow-Headers': 'Authorization,Content-Type' });
    res.end();
    return;
  }

  if (HTTPS_ENABLED && isProxyRequest(urlPath)) {
    const targetPort = urlPath.indexOf('/api/evidence') === 0 ? PROXY.evidencePort : PROXY.attendancePort;
    proxyRequest(req, res, targetPort);
    return;
  }

  if (urlPath === '/runtime-config.js') {
    var proxyMode = HTTPS_ENABLED || process.env.REVERSE_PROXY === 'true' || (process.env.NODE_ENV === 'production' && process.env.REVERSE_PROXY !== 'false');
    var evidencePort = process.env.EVIDENCE_PORT || 3030;
    var attendancePort = process.env.ATTENDANCE_PORT || 3031;
    var cfg = proxyMode
      ? {
          evidenceUrl: '/api/evidence',
          evidenceToken: process.env.EVIDENCE_ADMIN_TOKEN || 'dev-evidence-token-change-me',
          attendanceUrl: '',
          attendanceToken: process.env.ATTENDANCE_ADMIN_TOKEN || 'dev-evidence-token-change-me',
        }
      : {
          evidenceUrl: 'http://127.0.0.1:' + evidencePort + '/api/evidence',
          evidenceToken: process.env.EVIDENCE_ADMIN_TOKEN || 'dev-evidence-token-change-me',
          attendanceUrl: 'http://127.0.0.1:' + attendancePort,
          attendanceToken: process.env.ATTENDANCE_ADMIN_TOKEN || 'dev-evidence-token-change-me',
        };
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders() });
    res.end('window.__RUNTIME_CONFIG__ = ' + JSON.stringify(cfg) + ';');
    return;
  }

  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  let fullPath = path.resolve(ROOT_RESOLVED, '.' + filePath);

  if (!fullPath.startsWith(ROOT_RESOLVED + path.sep) && fullPath !== ROOT_RESOLVED) {
    if (!res.headersSent) res.writeHead(403, { ...securityHeaders(), 'Content-Type': 'text/plain' });
    if (!res.writableEnded) res.end('Forbidden');
    return;
  }

  const segments = urlPath.split('/').filter(Boolean);

  if (segments.length > 0 && segments[0] === 'server') {
    if (!res.headersSent) res.writeHead(403, { ...securityHeaders(), 'Content-Type': 'text/plain' });
    if (!res.writableEnded) res.end('Forbidden');
    return;
  }

  if (segments.length > 0 && segments[0].startsWith('.')) {
    if (!res.headersSent) res.writeHead(403, { ...securityHeaders(), 'Content-Type': 'text/plain' });
    if (!res.writableEnded) res.end('Forbidden');
    return;
  }

  const basename = segments.length > 0 ? segments[segments.length - 1] : 'index.html';
  if (['package.json', 'package-lock.json', 'Dockerfile', '.env', 'docker-compose.yml'].includes(basename)) {
    if (!res.headersSent) res.writeHead(403, { ...securityHeaders(), 'Content-Type': 'text/plain' });
    if (!res.writableEnded) res.end('Forbidden');
    return;
  }

  fs.stat(fullPath, (err, st) => {
    if (err || !st.isFile()) {
      if (!path.extname(urlPath) && !segments.some(s => s.includes('.'))) {
        fs.readFile(path.join(ROOT_RESOLVED, 'index.html'), (e, html) => {
          if (e) {
            if (!res.headersSent) res.writeHead(500, { ...securityHeaders(), 'Content-Type': 'text/plain' });
            if (!res.writableEnded) res.end('Internal Server Error');
            return;
          }
          res.writeHead(200, { ...securityHeaders(), 'Content-Type': MIME_TYPES['.html'] });
          res.end(html);
        });
        return;
      }
      if (!res.headersSent) res.writeHead(404, { ...securityHeaders(), 'Content-Type': 'text/plain' });
      if (!res.writableEnded) res.end('Not Found');
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    // STEP 1 (Web App Manifest): allow ONLY manifest.json to be served as JSON so
    // the PWA manifest is discoverable. Every other .json (e.g. runtime data/*.json
    // in the server data dir holding student/evidence records) stays forbidden.
    if (ext === '.json' && basename !== 'manifest.json') {
      if (!res.headersSent) res.writeHead(403, { ...securityHeaders(), 'Content-Type': 'text/plain' });
      if (!res.writableEnded) res.end('Forbidden');
      return;
    }
    if (!SERVED_EXTENSIONS.has(ext)) {
      if (!res.headersSent) res.writeHead(403, { ...securityHeaders(), 'Content-Type': 'text/plain' });
      if (!res.writableEnded) res.end('Forbidden');
      return;
    }

    const ctype = MIME_TYPES[ext];
    res.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': ctype,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    const stream = fs.createReadStream(fullPath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { ...securityHeaders(), 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    });
    stream.pipe(res);
  });
};

let server;
if (HTTPS_ENABLED) {
  const creds = loadHttpsCredentials();
  server = https.createServer(creds, requestHandler);
} else {
  server = http.createServer(requestHandler);
}

const listener = server.listen(PORT, () => {
  if (HTTPS_ENABLED) {
    console.log('[static-server] Serving static assets over HTTPS from ' + ROOT_RESOLVED + ' on :' + PORT);
  } else {
    console.log('[static-server] Serving static assets over HTTP from ' + ROOT_RESOLVED + ' on :' + PORT);
  }
  console.log('[static-server] SPA fallback enabled; sensitive paths blocked (/server/, hidden files, package files)');
  if (HTTPS_ENABLED) {
    console.log('[static-server] HTTPS enabled with security headers (HSTS=' + HTTPS_HSTS + ')');
  }
});

function shutdown(sig) {
  console.log('[static-server] Received ' + sig + ', closing...');
  listener.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = { server, requestHandler };
