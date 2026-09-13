'use strict';
/*
 * server/test-scan-history.js — STEP 7 validation harness.
 * Spawns the attendance-service with a test token and exercises:
 *   - POST /api/scans/log (log scan events with all result types)
 *   - GET /api/scans (list + filter by date/result/className)
 *   - authorization (401 without token / wrong token)
 *   - input validation (invalid result, invalid JSON)
 *   - persistence to scan_log.json on disk
 *   - no duplicate attendance records created (scan history is separate from attendance DB)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IN_SERVER = path.basename(__dirname) === 'server';
const SVC_ROOT = IN_SERVER ? path.join(__dirname, '..') : __dirname;
const SVC_PREFIX = IN_SERVER ? 'server/' : '';

const TOKEN = 'test-scan-history-token-777';
const PORT = 3093;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-hist-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

let pass = 0, fail = 0;
function assert(name, cond, extra) {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra ? '  :: ' + extra : '')); }
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

const env = {
    ...process.env,
    ATTENDANCE_PORT: String(PORT),
    ATTENDANCE_ADMIN_TOKEN: TOKEN,
    ATTENDANCE_DATA_DIR: dataDir,
};

const child = spawn(process.execPath, [SVC_PREFIX + 'attendance-service.js'], {
    cwd: SVC_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
});
let started = false;
child.stdout.on('data', d => { process.stdout.write('[srv] ' + d.toString()); if (d.toString().includes('protected admin service on')) started = true; });
child.stderr.on('data', d => process.stderr.write('[srv] ' + d.toString()));

const base = 'http://127.0.0.1:' + PORT;
const headers = (t) => ({ Authorization: 'Bearer ' + (t || TOKEN) });
const api = (method, p, body, opts) => {
    const h = (opts && opts.token === false) ? {} : headers(opts && opts.token);
    const cfg = body ? { method, headers: Object.assign({ 'Content-Type':'application/json' }, h), body: JSON.stringify(body) }
                     : { method, headers: h };
    return fetch(base + p, cfg)
        .then(r => r.json().catch(function () { return {}; }).then(d => ({ status: r.status, body: d })));
};

(async () => {
    for (let i = 0; i < 50 && !started; i++) await delay(100);
    if (!started) { console.error('server did not start'); process.exit(1); }

    const today = new Date();
    const dateStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');

    // 1. List scans on fresh DB -> empty
    let r = await api('GET', '/api/scans');
    assert('list scans fresh -> 200 empty', r.status === 200 && Array.isArray(r.body.scans) && r.body.scans.length === 0, JSON.stringify(r.body));

    // 2. Log a recognized scan
    r = await api('POST', '/api/scans/log', {
        studentId: 'S1', studentName: 'นาย ก', class: 'ม.4/1',
        result: 'recognized', attendanceStatus: 'present',
        evidenceRef: 'ev_test_001', confidence: 92,
        scanTime: Date.now(),
    });
    assert('log recognized -> 201', r.status === 201, `status=${r.status} body=${JSON.stringify(r.body)}`);
    const scanId1 = r.body.scanId;
    assert('log recognized returns scanId', !!scanId1, JSON.stringify(r.body));

    // 3. Log a second scan (different student)
    await api('POST', '/api/scans/log', {
        studentId: 'S2', studentName: 'นาง ข', class: 'ม.4/2',
        result: 'recognized', attendanceStatus: 'present',
        evidenceRef: null, confidence: 88,
        scanTime: Date.now(),
    });

    // 4. Log an unknown scan
    r = await api('POST', '/api/scans/log', {
        result: 'unknown', confidence: null,
        scanTime: Date.now(),
    });
    assert('log unknown -> 201', r.status === 201, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 5. Log a duplicate scan
    r = await api('POST', '/api/scans/log', {
        studentId: 'S1', studentName: 'นาย ก', class: 'ม.4/1',
        result: 'duplicate', attendanceStatus: 'duplicate',
        evidenceRef: null, confidence: 90,
        scanTime: Date.now(),
    });
    assert('log duplicate -> 201', r.status === 201, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 6. Log a failed scan
    r = await api('POST', '/api/scans/log', {
        result: 'failed', error: 'camera_unavailable',
        scanTime: Date.now(),
    });
    assert('log failed -> 201', r.status === 201, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 7. List all scans -> 5 entries
    r = await api('GET', '/api/scans?limit=100');
    assert('list scans returns 5', r.status === 200 && r.body.scans.length === 5, `body=${JSON.stringify(r.body).slice(0,200)}`);

    // 8. Filter by result=recognized -> 2
    r = await api('GET', '/api/scans?limit=100&result=recognized');
    assert('filter result=recognized -> 2', r.status === 200 && r.body.scans.length === 2, `body=${JSON.stringify(r.body).slice(0,200)}`);

    // 9. Filter by result=unknown -> 1
    r = await api('GET', '/api/scans?limit=100&result=unknown');
    assert('filter result=unknown -> 1', r.status === 200 && r.body.scans.length === 1, `body=${JSON.stringify(r.body).slice(0,200)}`);

    // 10. Filter by className=ม.4/1 -> 2 (S1 recognized + S1 duplicate)
    r = await api('GET', '/api/scans?limit=100&className=' + encodeURIComponent('ม.4/1'));
    assert('filter className=ม.4/1 -> 2', r.status === 200 && r.body.scans.length === 2, `body=${JSON.stringify(r.body).slice(0,200)}`);

    // 11. Scan record has server-computed date (not from client)
    var foundScan = r.body.scans.find(s => s.studentId === 'S1' && s.result === 'recognized');
    assert('scan has server-computed date', foundScan && foundScan.date === dateStr, `date=${foundScan && foundScan.date}`);
    assert('scan has evidenceRef', foundScan && foundScan.evidenceRef === 'ev_test_001', JSON.stringify(foundScan));
    assert('scan has attendanceStatus', foundScan && foundScan.attendanceStatus === 'present', JSON.stringify(foundScan));

    // 12. Scan has NO extra fields that don't belong
    assert('scan does not duplicate attendance records', !fs.existsSync(path.join(dataDir, 'attendance.json')), 'attendance.json should not exist');

    // 13. Invalid result -> 400
    r = await api('POST', '/api/scans/log', { result: 'maybe' });
    assert('invalid result -> 400', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 14. Missing result -> 400
    r = await api('POST', '/api/scans/log', {});
    assert('missing result -> 400', r.status === 400, `status=${r.status}`);

    // 15. Invalid JSON body -> 400
    r = await fetch(base + '/api/scans/log', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
        body: 'not json',
    }).then(resp => resp.json().catch(function () { return {}; }).then(d => ({ status: resp.status, body: d })));
    assert('invalid JSON -> 400', r.status === 400, `status=${r.status}`);

    // 16. No token -> 401
    r = await api('GET', '/api/scans', null, { token: false });
    assert('list scans without token -> 401', r.status === 401, `status=${r.status}`);
    r = await api('POST', '/api/scans/log', { result: 'recognized' }, { token: false });
    assert('log scan without token -> 401', r.status === 401, `status=${r.status}`);

    // 17. Wrong token -> 401
    r = await api('GET', '/api/scans', null, { token: 'wrong' });
    assert('wrong token -> 401', r.status === 401, `status=${r.status}`);

    // 18. Persistence: scan_log.json on disk
    const scanFile = path.join(dataDir, 'scan_log.json');
    assert('scan_log.json persisted on disk', fs.existsSync(scanFile), 'file should exist');
    const onDisk = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
    assert('scan_log.json has 5 records', onDisk.length === 5, `len=${onDisk.length}`);

    // 19. Newest-first ordering
    r = await api('GET', '/api/scans?limit=100');
    assert('newest-first: failed scan at index 0', r.body.scans[0].result === 'failed', JSON.stringify(r.body.scans[0]));

    // 20. Existing endpoints still work (no regression)
    r = await api('GET', '/health');
    assert('existing /health still works', r.body && r.body.ok === true, JSON.stringify(r.body));
    r = await api('GET', '/api/audit');
    assert('existing /api/audit still works', r.status === 200, `status=${r.status}`);

    child.kill();
    console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e); try { child.kill(); } catch (_) {} process.exit(1); });
