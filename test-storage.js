'use strict';
/*
 * server/test-storage.js — STEP 3 validation harness.
 * Spawns server/storage-service.js in an isolated temp dir with a test token
 * and exercises: valid image, invalid file, oversized, malformed, unauthorized,
 * invalid storage reference, plus a successful authenticated retrieval.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IN_SERVER = path.basename(__dirname) === 'server';
const SVC_ROOT = IN_SERVER ? path.join(__dirname, '..') : __dirname;
const SVC_PREFIX = IN_SERVER ? 'server/' : '';

const TOKEN = 'test-secret-token-123';
const PORT = 3077;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-stor-'));
const storageDir = path.join(tmpRoot, 'storage', 'evidence');
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(storageDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

let pass = 0, fail = 0;
function assert(name, cond, extra = '') {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra ? '  :: ' + extra : '')); }
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- minimal image fixtures ---
// JPEG: FF D8 FF ... <junk> ... FF D9 (valid if both markers present)
function makeJpeg(withEoi = true) {
    const head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const body = Buffer.from('pretend-jpeg-payload-data');
    const tail = withEoi ? Buffer.from([0xFF, 0xD9]) : Buffer.from([0x00, 0x00]);
    return Buffer.concat([head, body, tail]);
}
// PNG: 8-byte signature + IHDR + IEND (structural skeleton; validator only checks magic+IEND)
function makePng() {
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdrLen = Buffer.from([0x00, 0x00, 0x00, 0x0D]);
    const ihdrType = Buffer.from('IHDR');
    const ihdrData = Buffer.alloc(13, 0);
    const ihdrCrc = Buffer.alloc(4, 0);
    const iendLen = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const iendType = Buffer.from('IEND');
    const iendCrc = Buffer.from([0xAE, 0x42, 0x60, 0x82]); // correct IEND CRC is AE 42 60 82
    return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, ihdrCrc, iendLen, iendType, iendCrc]);
}

const env = {
    ...process.env,
    EVIDENCE_PORT: String(PORT),
    EVIDENCE_ADMIN_TOKEN: TOKEN,
    EVIDENCE_STORAGE_DIR: storageDir,
    EVIDENCE_DATA_DIR: dataDir,
    EVIDENCE_MAX_BYTES: String(512 * 1024),
};

const child = spawn(process.execPath, [SVC_PREFIX + 'storage-service.js'], {
    cwd: SVC_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
});
let started = false;
child.stdout.on('data', d => { process.stdout.write('[srv] ' + d.toString()); if (d.toString().includes('secure storage service on')) started = true; });
child.stderr.on('data', d => process.stderr.write('[srv] ' + d.toString()));

(async () => {
    // wait for server
    for (let i = 0; i < 50 && !started; i++) await delay(100);
    if (!started) { console.error('server did not start'); process.exit(1); }

    const base = `http://127.0.0.1:${PORT}`;
    const authHeaders = (t = TOKEN) => ({ Authorization: `Bearer ${t}` });
    const post = (body, opts = {}) => {
        const headers = { 'Content-Type': opts.type || 'image/jpeg', ...(opts.token === false ? {} : authHeaders(opts.token)), ...(opts.extraHeaders || {}) };
        return fetch(base + '/api/evidence', { method: 'POST', headers, body });
    };
    const get = (id, opts = {}) => {
        const headers = opts.token === false ? {} : authHeaders(opts.token);
        return fetch(base + '/api/evidence/' + id, { method: 'GET', headers });
    };

    // 1. valid image (JPEG) with auth + attendance id linkage
    const ATT_ID = crypto.randomUUID();
    let r = await post(makeJpeg(true), { extraHeaders: { 'X-Attendance-Id': ATT_ID } });
    let j = await r.json();
    assert('valid JPEG returns 201', r.status === 201, `status=${r.status} body=${JSON.stringify(j)}`);
    assert('valid JPEG returns evidenceId', !!j.evidenceId, JSON.stringify(j));
    assert('valid JPEG returns storageRef', !!j.storageRef && j.storageRef.endsWith('.jpg'), JSON.stringify(j));
    assert('valid JPEG echoes attendanceId', j.attendanceId === ATT_ID, `got=${j.attendanceId}`);
    assert('file written to storage dir', fs.readdirSync(storageDir).some(f => f === j.storageRef));
    const r0_storageRef = j.storageRef;
    const r0_evidenceId = j.evidenceId;
    const evId = j.evidenceId;
    const ref = j.storageRef;

    // also test PNG
    r = await post(makePng(), { type: 'image/png' });
    j = await r.json();
    assert('valid PNG returns 201', r.status === 201, `status=${r.status} body=${JSON.stringify(j)}`);
    assert('PNG stored with .png ref', !!j.storageRef && j.storageRef.endsWith('.png'), JSON.stringify(j));

    // 1c. duplicate attendance id -> 409 reuse (one evidence per attendance event)
    const filesBefore = fs.readdirSync(storageDir).length;
    r = await post(makeJpeg(true), { extraHeaders: { 'X-Attendance-Id': ATT_ID } });
    j = await r.json();
    assert('duplicate attendanceId -> 409', r.status === 409, `status=${r.status} body=${JSON.stringify(j)}`);
    assert('409 returns existing evidenceId', j.evidenceId && j.storageRef, JSON.stringify(j));
    assert('409 returns same storageRef as original', j.storageRef === r0_storageRef, `got=${j.storageRef}`);
    assert('no extra file written on 409', fs.readdirSync(storageDir).length === filesBefore, `files=${fs.readdirSync(storageDir).length}`);

    // 1d. invalid attendance id format -> 400
    r = await post(makeJpeg(true), { extraHeaders: { 'X-Attendance-Id': 'not-a-uuid' } });
    j = await r.json();
    assert('invalid attendance id format -> 400', r.status === 400, `status=${r.status} body=${JSON.stringify(j)}`);

    // 2. invalid file (text, not an image) with image/jpeg content-type
    r = await post(Buffer.from('hello this is not an image at all'));
    j = await r.json();
    assert('invalid file (text) rejected with 415', r.status === 415, `status=${r.status} body=${JSON.stringify(j)}`);

    // 2b. content-type mismatch: PNG bytes sent as image/jpeg
    r = await post(makePng(), { type: 'image/jpeg' });
    j = await r.json();
    assert('content-type mismatch rejected with 415', r.status === 415, `status=${r.status} body=${JSON.stringify(j)}`);

    // 3. oversized file (>512KB)
    const big = Buffer.alloc(600 * 1024, 0xFF); // 600KB of 0xFF — not a valid image either, but size is checked first via content-length
    r = await post(big, { type: 'image/jpeg' });
    j = await r.json().catch(() => ({}));
    assert('oversized file rejected with 413', r.status === 413, `status=${r.status} body=${JSON.stringify(j)}`);

    // 4. malformed image (JPEG magic but missing FF D9 EOI)
    r = await post(makeJpeg(false));
    j = await r.json();
    assert('malformed image rejected with 422', r.status === 422, `status=${r.status} body=${JSON.stringify(j)}`);

    // 5. unauthorized access
    r = await post(makeJpeg(true), { token: false });
    assert('upload without token → 401', r.status === 401, `status=${r.status}`);
    r = await post(makeJpeg(true), { token: 'wrong-token' });
    assert('upload wrong token → 401', r.status === 401, `status=${r.status}`);
    r = await get(evId, { token: false });
    assert('retrieve without token → 401', r.status === 401, `status=${r.status}`);

    // 6. invalid storage reference
    r = await get('not-a-uuid', { token: TOKEN });
    assert('invalid (non-uuid) storage reference → 400', r.status === 400, `status=${r.status}`);
    // valid uuid format but nonexistent
    const ghost = crypto.randomUUID();
    r = await get(ghost, { token: TOKEN });
    assert('nonexistent evidenceId → 404', r.status === 404, `status=${r.status}`);

    // 7. successful authenticated retrieval of valid evidence
    r = await get(evId, { token: TOKEN });
    assert('retrieve valid evidence → 200', r.status === 200, `status=${r.status}`);
    assert('retrieve sets image/jpeg content-type', r.headers.get('content-type') === 'image/jpeg', r.headers.get('content-type'));
    assert('retrieve uses attachment disposition (no inline)', (r.headers.get('content-disposition') || '').includes('attachment'));
    const arr = await r.arrayBuffer();
    const disk = fs.readFileSync(path.join(storageDir, ref));
    assert('retrieved bytes match stored file', Buffer.from(arr).equals(disk));

    // 8. only 1 file per successful upload stored (no dup on repeated valid upload — separate records allowed)
    const filesAfter = fs.readdirSync(storageDir).length;
    assert('storage dir has >=1 evidence file', filesAfter >= 1, `files=${filesAfter}`);

    // 9. metadata file contains only safe references (no image bytes, no student info)
    const metaRaw = fs.readFileSync(path.join(dataDir, 'evidence.json'), 'utf8');
    const hasB64 = metaRaw.includes('data:image');
    const hasStudentId = metaRaw.includes('studentId');
    assert('metadata stores no base64 image data', !hasB64);
    assert('metadata stores no studentId/name (sensitive)', !hasStudentId);

    child.kill();
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e); process.exit(1); });
