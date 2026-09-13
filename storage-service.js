'use strict';
/*
 * server/storage-service.js
 * STEP 3 — Secure Attendance Evidence storage service.
 *
 * A minimal, dependency-free (Node built-ins only) HTTP service that provides:
 *   POST /api/evidence        — authenticated admin upload of one evidence image
 *   GET  /api/evidence/:id    — authenticated admin retrieval (streamed, not public)
 *   OPTIONS /api/evidence     — CORS preflight
 *   GET  /health
 *
 * Security properties (STEP 3 requirements):
 *   - Server-side validation: MIME via magic bytes (not trusted Content-Type),
 *     size cap, malformed-image structural check (magic + EOF markers).
 *   - Images stored ONLY on disk in a non-public directory (STORAGE_DIR). No
 *     image is ever placed in localStorage, cookies, JWT, or a DB base64 column.
 *   - Server-generated filename: crypto.randomUUID() + extension derived from
 *     detected magic bytes. No student name / student ID / user filename.
 *   - The DB (metadata) stores only a safe reference (storageRef = filename).
 *   - Server-side access control: Bearer token checked (constant-time) before
 *     any handler. Missing/wrong token → 401. Origin allowlist for CORS.
 *   - Path-traversal hardened on retrieval (realpath ∈ STORAGE_DIR).
 *   - Failure cleanup: if metadata write fails after file write, the orphaned
 *     file is deleted.
 *
 * This server is the secure store for images captured in STEP 4. It does NOT
 * touch face recognition or attendance business logic.
 */

const http = require('http');
const crypto = require('crypto');
const supabase = require('./supabase-client');
const { loadTable, saveTable } = require('./supabase-store');

const TBL_EVIDENCE = 'evidence';

const CONFIG = {
    PORT: Number(process.env.EVIDENCE_PORT || 3030),
    ADMIN_TOKEN: process.env.EVIDENCE_ADMIN_TOKEN || 'dev-evidence-token-change-me',
    MAX_FILE_BYTES: Number(process.env.EVIDENCE_MAX_BYTES || (512 * 1024)),
    ALLOWED_ORIGINS: (process.env.EVIDENCE_ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean),
    ALLOWED: new Map([
        ['image/jpeg', { ext: '.jpg', magic: [0xFF, 0xD8, 0xFF], endMagic: [0xFF, 0xD9] }],
        ['image/png',  { ext: '.png', magic: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], endMagic: [0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82] }],
    ]),
    // Private Supabase Storage bucket (see supabase-schema.sql) — never made public.
    BUCKET: process.env.EVIDENCE_BUCKET || 'evidence-photos',
};

function securityHeaders(req) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=self, microphone=(), geolocation=(), payment=()',
  };
  if ((req && (req.headers['x-forwarded-proto'] === 'https' || req.socket && req.socket.encrypted)) || process.env.HTTPS_ENABLED === 'true') {
    h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return h;
}

if (!process.env.EVIDENCE_ADMIN_TOKEN) {
    console.warn('[SECURITY] EVIDENCE_ADMIN_TOKEN unset — using insecure dev default. Set EVIDENCE_ADMIN_TOKEN in production.');
}

function loadMeta() { return loadTable(TBL_EVIDENCE); }
function saveMeta(list) { return saveTable(TBL_EVIDENCE, list, 'evidenceId'); }

function bufEqual(arr1, buf, off) {
    if (buf.length < off + arr1.length) return false;
    for (let i = 0; i < arr1.length; i++) if (buf[off + i] !== arr1[i]) return false;
    return true;
}
function detectMime(buf) {
    if (bufEqual(CONFIG.ALLOWED.get('image/jpeg').magic, buf, 0)) return 'image/jpeg';
    if (bufEqual(CONFIG.ALLOWED.get('image/png').magic, buf, 0)) return 'image/png';
    return null;
}
function isMalformed(buf, mime) {
    const spec = CONFIG.ALLOWED.get(mime); if (!spec) return true;
    if (!bufEqual(spec.magic, buf, 0)) return true;
    // trailing EOF marker
    const off = buf.length - spec.endMagic.length;
    for (let i = 0; i < spec.endMagic.length; i++) if (buf[off + i] !== spec.endMagic[i]) return true;
    return false;
}
function isSafeFilename(name) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 128) return false;
    if (/[\\/]/.test(name) || name.includes('..')) return false;
    return true;
}
function isAuthorized(req) {
    const h = req.headers['authorization'] || '';
    if (!h.startsWith('Bearer ')) return false;
    const a = Buffer.from(h.slice('Bearer '.length).trim(), 'utf8');
    const b = Buffer.from(CONFIG.ADMIN_TOKEN, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}
function corsHeaders(req) {
    const origin = req.headers.origin;
    if (CONFIG.ALLOWED_ORIGINS.indexOf('*') !== -1) {
        return {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization,Content-Type',
            'Access-Control-Max-Age': '86400',
        };
    }
    if (origin && CONFIG.ALLOWED_ORIGINS.indexOf(origin) !== -1) {
        return {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization,Content-Type',
            'Access-Control-Max-Age': '86400',
            'Vary': 'Origin',
        };
    }
    return null;
}
function jsonRes(res, req, code, obj, extra = {}) {
    const cors = corsHeaders(req);
    const sec = securityHeaders(req);
    if (!cors) {
        const b = JSON.stringify({ error: 'origin not allowed' });
        res.writeHead(403, { ...sec, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
        return res.end(b);
    }
    const b = JSON.stringify(obj);
    res.writeHead(code, {
        ...sec,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(b),
        'Cache-Control': 'no-store',
        ...cors, ...extra,
    });
    res.end(b);
}

function handleOptions(req, res) {
    const cors = corsHeaders(req);
    if (!cors) return jsonRes(res, req, 403, { error: 'origin not allowed' });
    res.writeHead(204, { ...securityHeaders(req), ...cors });
    res.end();
}
async function handleUpload(req, res) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });

    const ctype = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!CONFIG.ALLOWED.has(ctype)) return jsonRes(res, req, 415, { error: 'unsupported media type' });

    // Attendance ID (foreign key to the Attendance record) — enables the
    // one-evidence-per-attendance constraint. Optional header so storage-only
    // uploads remain possible, but the scanner always sends it.
    const attendanceId = (req.headers['x-attendance-id'] || '').trim() || null;
    if (attendanceId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attendanceId)) {
        return jsonRes(res, req, 400, { error: 'invalid attendance id' });
    }

    // RACE CONDITION GUARD (server-side DB constraint analog): one evidence per
    // attendance event. If a record already exists for this attendanceId, reuse it
    // instead of creating a duplicate (409).
    const existingList = await loadMeta();
    const existing = attendanceId ? existingList.find(r => r.attendanceId === attendanceId) : null;
    if (existing) {
        return jsonRes(res, req, 409, {
            error: 'evidence already exists for this attendance',
            evidenceId: existing.evidenceId,
            storageRef: existing.storageRef,
            attendanceId: existing.attendanceId,
        });
    }

    const cl = parseInt(req.headers['content-length'] || '0', 10);
    if (cl && cl > CONFIG.MAX_FILE_BYTES) return jsonRes(res, req, 413, { error: 'payload too large' });

    const chunks = []; let total = 0; let aborted = false;
    req.on('data', c => {
        total += c.length;
        if (total > CONFIG.MAX_FILE_BYTES) { aborted = true; req.destroy(); return; }
        chunks.push(c);
    });
    req.on('error', () => { if (!aborted) jsonRes(res, req, 400, { error: 'stream error' }); });
    req.on('end', async () => {
        if (aborted) return jsonRes(res, req, 413, { error: 'payload too large' });
        const buf = Buffer.concat(chunks);
        const detected = detectMime(buf);
        if (!detected) return jsonRes(res, req, 415, { error: 'unrecognized image format' });
        if (detected !== ctype) return jsonRes(res, req, 415, { error: 'content-type does not match file content' });
        if (buf.length > CONFIG.MAX_FILE_BYTES) return jsonRes(res, req, 413, { error: 'payload too large' });
        if (isMalformed(buf, detected)) return jsonRes(res, req, 422, { error: 'malformed image' });
        if (buf.length === 0) return jsonRes(res, req, 422, { error: 'empty image' });

        const ext = CONFIG.ALLOWED.get(detected).ext;
        const filename = crypto.randomUUID() + ext;
        if (!isSafeFilename(filename)) return jsonRes(res, req, 500, { error: 'internal filename error' });

        // Upload to the private Supabase Storage bucket (server-generated key —
        // no student name/ID in the path, mirrors the old on-disk filename scheme).
        const { error: upErr } = await supabase.storage
            .from(CONFIG.BUCKET)
            .upload(filename, buf, { contentType: detected, upsert: false });
        if (upErr) {
            console.error('[storage] upload failed:', upErr.message);
            return jsonRes(res, req, 500, { error: 'storage write failed' });
        }

        const now = Date.now();
        const record = {
            evidenceId: crypto.randomUUID(),
            storageRef: filename,
            captureAt: now,
            fileType: detected,
            fileSize: buf.length,
            status: 'available',
            createdAt: now,
            attendanceId: attendanceId,   // FK to the attendance event
        };
        try {
            const list = await loadMeta();
            // re-check uniqueness inside the write window (guards concurrent uploads)
            if (attendanceId && list.some(r => r.attendanceId === attendanceId)) {
                await supabase.storage.from(CONFIG.BUCKET).remove([filename]); // duplicate -> remove the file we just wrote
                const dup = list.find(r => r.attendanceId === attendanceId);
                return jsonRes(res, req, 409, {
                    error: 'evidence already exists for this attendance',
                    evidenceId: dup.evidenceId, storageRef: dup.storageRef, attendanceId: dup.attendanceId,
                });
            }
            list.push(record);
            await saveMeta(list);
        } catch (metaErr) {
            await supabase.storage.from(CONFIG.BUCKET).remove([filename]); // (7) cleanup orphaned file
            console.error('[storage] orphaned-file cleanup:', metaErr.message);
            return jsonRes(res, req, 500, { error: 'metadata persistence failed; orphaned file removed' });
        }
        jsonRes(res, req, 201, {
            evidenceId: record.evidenceId, storageRef: record.storageRef,
            fileType: record.fileType, fileSize: record.fileSize, attendanceId: record.attendanceId,
        });
    });
}
async function handleRetrieve(req, res) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts[1] !== 'evidence' || !parts[2]) return jsonRes(res, req, 404, { error: 'not found' });
    const evidenceId = parts[2];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(evidenceId)) {
        return jsonRes(res, req, 400, { error: 'invalid storage reference' });
    }
    const list = await loadMeta();
    const rec = list.find(r => r.evidenceId === evidenceId);
    if (!rec) return jsonRes(res, req, 404, { error: 'evidence not found' });
    if (rec.status !== 'available') return jsonRes(res, req, 404, { error: 'evidence not available' });
    const ref = rec.storageRef;
    if (!isSafeFilename(ref)) return jsonRes(res, req, 400, { error: 'invalid storage reference' });

    const cors = corsHeaders(req);
    if (!cors) return jsonRes(res, req, 403, { error: 'origin not allowed' });

    const { data, error: dlErr } = await supabase.storage.from(CONFIG.BUCKET).download(ref);
    if (dlErr || !data) {
        rec.status = 'missing';
        try { await saveMeta(list); } catch (e) { console.error('[meta] save error:', e.message); }
        return jsonRes(res, req, 404, { error: 'evidence file missing' });
    }
    const buf = Buffer.from(await data.arrayBuffer());
    res.writeHead(200, {
        'Content-Type': rec.fileType,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment',
        ...securityHeaders(req),
        ...cors,
    });
    res.end(buf);
}
function handleHealth(req, res) { jsonRes(res, req, 200, { status: 'ok' }); }

const server = http.createServer((req, res) => {
    const method = req.method;
    const urlPath = new URL(req.url, 'http://x').pathname;
    if (method === 'OPTIONS') return handleOptions(req, res);
    if (method === 'GET' && urlPath === '/api/evidence/health') return handleHealth(req, res);
    if (method === 'POST' && urlPath === '/api/evidence') return handleUpload(req, res);
    if (method === 'GET' && urlPath === '/health') return handleHealth(req, res);
    if (method === 'GET' && urlPath.startsWith('/api/evidence/')) return handleRetrieve(req, res);
    jsonRes(res, req, 404, { error: 'not found' });
});
const listener = server.listen(CONFIG.PORT, () => {
    console.log(`[evidence-storage] secure storage service on :${CONFIG.PORT}`);
    console.log(`[evidence-storage] Supabase Storage bucket: ${CONFIG.BUCKET}`);
    console.log(`[evidence-storage] metadata table: ${TBL_EVIDENCE}`);
    console.log(`[evidence-storage] cors origins: ${JSON.stringify(CONFIG.ALLOWED_ORIGINS)}`);
});

// Graceful shutdown (avoids libuv teardown assertion on SIGTERM/SIGINT).
function gracefulShutdown(sig) {
    console.log(`[evidence-storage] received ${sig}; closing...`);
    listener.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

module.exports = { server, CONFIG, detectMime, isMalformed, isSafeFilename, handleUpload, handleRetrieve };
