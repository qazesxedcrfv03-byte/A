'use strict';
/*
 * server/build.js — Build step for the static frontend + backend.
 *
 * This project has no bundler or compilation step. The frontend is static
 * HTML/CSS/JS served directly. This script validates that all required
 * application assets are present before the project is considered "built".
 *
 * It checks:
 *   - Frontend entry point (index.html)
 *   - Stylesheet (style.css)
 *   - Frontend scripts (app.js, scan.js, register.js, evidence.js, roster.js,
 *     leave.js, chatbot.js, keywords.js, calibrate.js)
 *   - Backend services (server/storage-service.js, server/attendance-service.js)
 *
 * Exits non-zero if any required file is missing.
 */
const fs = require('fs');
const path = require('path');

const IN_SERVER = path.basename(__dirname) === 'server';
const ROOT = IN_SERVER ? path.join(__dirname, '..') : __dirname;
const s = (name) => IN_SERVER ? path.join('server', name) : name;
const REQUIRED = [
  'index.html',
  'style.css',
  'app.js',
  'scan.js',
  'register.js',
  'evidence.js',
  'roster.js',
  'leave.js',
  'chatbot.js',
  'keywords.js',
  'calibrate.js',
  'class-model.js',
  'Ui enhance.js',
  'can.png',
  s('storage-service.js'),
  s('attendance-service.js'),
  s('start.js'),
  s('generate-cert.js'),
];

let missing = [];
REQUIRED.forEach((rel) => {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    missing.push(rel);
  }
});

if (missing.length > 0) {
  console.error('BUILD FAIL — missing required files:');
  missing.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}

console.log('Build OK — ' + REQUIRED.length + ' required asset(s) present.');
console.log('Static frontend ready (index.html, *.js, *.css).');
console.log('Backend services ready (storage-service, attendance-service).');
