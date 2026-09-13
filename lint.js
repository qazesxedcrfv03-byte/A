'use strict';
/*
 * server/lint.js — Zero-dependency syntax linter.
 *
 * Runs `node --check` on every .js file in the project root and server/
 * directory (excluding generated data, storage, node_modules, .git).
 * Fails fast on the first syntax error. No external linter packages required.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const IN_SERVER = path.basename(__dirname) === 'server';
const ROOT = IN_SERVER ? path.join(__dirname, '..') : __dirname;
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'server/data', 'server/storage']);
const ROOT_FILES = [
  'app.js', 'scan.js', 'register.js', 'evidence.js', 'roster.js',
  'leave.js', 'chatbot.js', 'keywords.js', 'calibrate.js', 'Ui enhance.js',
  'class-model.js',
];
const SERVER_DIR = path.join(ROOT, 'server');

let checked = 0;
let failed = false;

function checkFile(relPath) {
  if (failed) return;
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) return;
  try {
    execFileSync(process.execPath, ['--check', full], { stdio: 'ignore' });
    checked++;
  } catch (e) {
    failed = true;
    console.error('LINT FAIL: ' + relPath);
    if (e.stderr) process.stderr.write(e.stderr.toString());
    if (e.stdout) process.stdout.write(e.stdout.toString());
  }
}

ROOT_FILES.forEach(checkFile);

if (fs.existsSync(SERVER_DIR)) {
  const serverFiles = fs.readdirSync(SERVER_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.js'))
    .map(e => path.join('server', e.name));
  serverFiles.forEach(checkFile);
} else {
  const HOST_BACKEND = [
    'start.js', 'static-server.js', 'storage-service.js', 'attendance-service.js',
    'healthcheck.js', 'generate-cert.js',
  ];
  HOST_BACKEND.forEach(f => checkFile(f));
}

console.log('Linted ' + checked + ' JavaScript file(s).');
if (failed) {
  console.error('Lint failed.');
  process.exit(1);
}
console.log('Lint passed.');
