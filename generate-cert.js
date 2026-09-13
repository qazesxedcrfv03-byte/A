'use strict';
/*
 * generate-cert.js — Generate self-signed TLS certificates for local HTTPS.
 *
 * Uses the system `openssl` binary (spawned via Node's child_process).
 * openssl is pre-installed on macOS, all Linux distros, and available via
 * Git for Windows or WSL on Windows.
 *
 * Usage:
 *   node generate-cert.js                # writes to server/storage/certs/dev-key.pem + dev-cert.pem
 *   node generate-cert.js --out DIR      # writes to DIR/dev-key.pem + dev-cert.pem
 *   node generate-cert.js --key PATH --cert PATH  # writes to explicit paths
 *
 * The generated certificate is a self-signed X.509 valid for "localhost" and
 * "127.0.0.1" (365 days). Browsers will show a security warning — accept it once
 * or install the cert into the system trust store for a seamless local dev experience.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const args = { out: null, key: null, cert: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) { args.out = argv[++i]; }
    else if (argv[i] === '--key' && argv[i + 1]) { args.key = argv[++i]; }
    else if (argv[i] === '--cert' && argv[i + 1]) { args.cert = argv[++i]; }
    else if (argv[i] === '--help' || argv[i] === '-h') { args.help = true; }
  }
  return args;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log('Usage: node generate-cert.js [--out DIR] [--key PATH --cert PATH]');
  console.log('  Generates a self-signed TLS cert for localhost + 127.0.0.1 (365 days).');
  process.exit(0);
}

const outDir = args.out
  || (path.basename(__dirname) === 'server' ? path.join(__dirname, '..', 'server', 'storage', 'certs') : path.join(__dirname, 'server', 'storage', 'certs'));
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const keyPath = args.key || path.join(outDir, 'dev-key.pem');
const certPath = args.cert || path.join(outDir, 'dev-cert.pem');

function opensslAvailable() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

if (!opensslAvailable()) {
  console.error('[generate-cert] ERROR: openssl is not installed or not on PATH.');
  console.error('[generate-cert] Install openssl (macOS: brew install openssl, Linux: apt install openssl, Windows: install Git for Windows or WSL).');
  console.error('[generate-cert] Alternatively, use Docker/Caddy (docker compose up) which handles TLS automatically.');
  process.exit(1);
}

const cmd = [
  'openssl', 'req', '-x509', '-newkey', 'rsa:2048',
  '-keyout', keyPath,
  '-out', certPath,
  '-days', '365',
  '-nodes',
  '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
];

execFileSync(cmd[0], cmd.slice(1), { stdio: 'pipe' });
fs.chmodSync(keyPath, 0o600);
fs.chmodSync(certPath, 0o644);

console.log('[generate-cert] Self-signed certificate generated:');
console.log('  Key  : ' + keyPath);
console.log('  Cert : ' + certPath);
console.log('  Valid for: localhost, 127.0.0.1 (365 days, sha256WithRSA)');
console.log('[generate-cert] This is a DEVELOPMENT certificate. For production, use Caddy/Let\'s Encrypt (docker compose up).');
