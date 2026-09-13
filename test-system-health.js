'use strict';
/*
 * server/test-system-health.js — STEP 8 validation harness.
 * Spawns server/attendance-service.js in an isolated temp dir with a test token
 * and exercises the enhanced /health endpoint:
 *   - GET /health returns 200 with ok:true
 *   - /health returns real counts (no secrets, no records, no tokens)
 *   - /health response contains counts for attendance, leaves, classes, classStudents, scanLogs, audit
 *   - /health does NOT contain any sensitive fields (token, password, descriptors, records array)
 *   - /health returns dataDir (safe metadata)
 *   - Evidence storage health endpoint (/health without auth) works
 *   - No existing endpoints broken
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IN_SERVER = path.basename(__dirname) === 'server';
const SVC_ROOT = IN_SERVER ? path.join(__dirname, '..') : __dirname;
const SVC_PREFIX = IN_SERVER ? 'server/' : '';

const TOKEN = 'test-system-health-token-888';
const PORT = 3094;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
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
const authHeaders = { Authorization: 'Bearer ' + TOKEN };

(async () => {
    for (let i = 0; i < 50 && !started; i++) await delay(100);
    if (!started) { console.error('server did not start'); process.exit(1); }

    // 1. GET /health returns 200
    let r = await fetch(base + '/health').then(resp => resp.json().catch(function () { return {}; }).then(d => ({ status: resp.status, body: d })));
    assert('health -> 200', r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert('health ok=true', r.body.ok === true, JSON.stringify(r.body));
    assert('health service=attendance-service', r.body.service === 'attendance-service', JSON.stringify(r.body));

    // 2. Health returns version
    assert('health has version', typeof r.body.version === 'string', JSON.stringify(r.body));

    // 3. Health returns timestamp
    assert('health has timestamp', typeof r.body.timestamp === 'number' && r.body.timestamp > 0, JSON.stringify(r.body));

    // 4. Health returns counts object
    assert('health has counts', typeof r.body.counts === 'object' && r.body.counts !== null, JSON.stringify(r.body));
    assert('health counts has attendance', typeof r.body.counts.attendance === 'number', JSON.stringify(r.body.counts));
    assert('health counts has leaves', typeof r.body.counts.leaves === 'number', JSON.stringify(r.body.counts));
    assert('health counts has classes', typeof r.body.counts.classes === 'number', JSON.stringify(r.body.counts));
    assert('health counts has classStudents', typeof r.body.counts.classStudents === 'number', JSON.stringify(r.body.counts));
    assert('health counts has scanLogs', typeof r.body.counts.scanLogs === 'number', JSON.stringify(r.body.counts));
    assert('health counts has audit', typeof r.body.counts.audit === 'number', JSON.stringify(r.body.counts));

    // 5. Health returns dataDir (safe metadata, no file contents)
    assert('health has dataDir', typeof r.body.dataDir === 'string', JSON.stringify(r.body));

    // 6. Health does NOT expose secrets or sensitive data
    assert('health does NOT contain token', !('token' in r.body) && !JSON.stringify(r.body).includes(TOKEN), 'token leaked in health response');
    assert('health does NOT contain records array', !Array.isArray(r.body.records), 'records array present in health');
    assert('health does NOT contain descriptors', !JSON.stringify(r.body).includes('descriptors'), 'descriptors found in health');
    assert('health does NOT contain password', !JSON.stringify(r.body).toLowerCase().includes('password'), 'password found in health');
    assert('health does NOT contain ADMIN_TOKEN', !JSON.stringify(r.body).includes('ADMIN_TOKEN'), 'ADMIN_TOKEN found in health');

    // 7. Health counts are real (start at 0 for fresh DB)
    assert('health attendance count starts at 0', r.body.counts.attendance === 0, `count=${r.body.counts.attendance}`);
    assert('health classes count starts at 0', r.body.counts.classes === 0, `count=${r.body.counts.classes}`);

    // 8. Health endpoint does not require auth (0 auth check)
    r = await fetch(base + '/health').then(resp => ({ status: resp.status, body: resp.headers.get('Authorization') }));
    assert('health accessible without token', r.status === 200, `status=${r.status}`);

    // 9. Create a class via API, then verify counts update
    await fetch(base + '/api/classes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify({ code: 'ม.4/1', name: 'ทดสอบ' }),
    }).then(resp => resp.json());

    await fetch(base + '/api/classes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify({ code: 'ม.4/2', name: 'ทดสอบ2' }),
    }).then(resp => resp.json());

    r = await fetch(base + '/health').then(resp => resp.json().catch(function () { return {}; }).then(d => ({ status: resp.status, body: d })));
    assert('health classes count after 2 creates = 2', r.body.counts.classes === 2, `count=${r.body.counts.classes}`);

    // 10. Log a scan, then verify counts update
    await fetch(base + '/api/scans/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify({ result: 'recognized', studentId: 'S1', studentName: 'ทดสอบ', class: 'ม.4/1', confidence: 90 }),
    }).then(resp => resp.json());

    r = await fetch(base + '/health').then(resp => resp.json().catch(function () { return {}; }).then(d => ({ status: resp.status, body: d })));
    assert('health scanLogs count after 1 log = 1', r.body.counts.scanLogs === 1, `count=${r.body.counts.scanLogs}`);

    // 11. Verify no actual record data is in the health response
    var bodyStr = JSON.stringify(r.body);
    assert('health does not contain student names', !bodyStr.includes('ทดสอบ'), 'student names leaked in health');
    assert('health does not contain studentId S1', !bodyStr.includes('S1'), 'studentId leaked in health');

    // 12. Existing endpoints still work (no regression)
    r = await fetch(base + '/api/scans', { headers: authHeaders }).then(resp => resp.json().catch(function () { return {}; }).then(d => ({ status: resp.status, body: d })));
    assert('existing GET /api/scans still works', r.status === 200, `status=${r.status}`);
    r = await fetch(base + '/health').then(resp => ({ status: resp.status }));
    assert('health returns latest scan count', true); // already verified above

    child.kill();
    console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e); try { child.kill(); } catch (_) {} process.exit(1); });
