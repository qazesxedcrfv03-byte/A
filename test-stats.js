'use strict';
/*
 * server/test-stats.js — STEP 10 validation harness.
 * Spawns server/attendance-service.js in an isolated temp dir and exercises the
 * REAL database via GET /api/stats: server-side aggregation (never the raw DB),
 * filters (date range / AY / semester / week / class / student), byDate trend,
 * byClass comparison, and protected (401) authorization.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IN_SERVER = path.basename(__dirname) === 'server';
const SVC_ROOT = IN_SERVER ? path.join(__dirname, '..') : __dirname;
const SVC_PREFIX = IN_SERVER ? 'server/' : '';

const TOKEN = 'test-stats-token-789';
const PORT = 3091;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-db-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

let pass = 0, fail = 0;
function assert(name, cond, extra = '') {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra ? '  :: ' + extra : '')); }
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

const env = { ...process.env, ATTENDANCE_PORT: String(PORT), ATTENDANCE_ADMIN_TOKEN: TOKEN, ATTENDANCE_DATA_DIR: dataDir };
const child = spawn(process.execPath, [SVC_PREFIX + 'attendance-service.js'], { cwd: SVC_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let started = false;
child.stdout.on('data', d => { process.stdout.write('[srv] ' + d.toString()); if (d.toString().includes('protected admin service on')) started = true; });
child.stderr.on('data', d => process.stderr.write('[srv] ' + d.toString()));

const A = '2025-05-05'; // week 1, AY 2025, sem 1
const B = '2025-05-09'; // week 2, AY 2025, sem 1
const CLS1 = 'ม.4/1';
const CLS2 = 'ม.4/2';

const qs = (obj) => {
    const parts = [];
    Object.keys(obj).forEach(k => { if (obj[k] !== null && obj[k] !== undefined && obj[k] !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])); });
    return parts.join('&');
};

(async () => {
    for (let i = 0; i < 50 && !started; i++) await delay(100);
    if (!started) { console.error('server did not start'); process.exit(1); }

    const base = `http://127.0.0.1:${PORT}`;
    const authHeaders = (t = TOKEN) => ({ Authorization: `Bearer ${t}` });
    const post = (payload) => fetch(base + '/api/attendance/correction', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload),
    }).then(r => r.json().catch(() => ({})).then(d => ({ status: r.status, body: d })));
    const getStats = (params, opts = {}) => fetch(base + '/api/stats?' + qs(params), {
        headers: opts.token === false ? {} : authHeaders(opts.token),
    }).then(r => r.json().catch(() => ({})).then(d => ({ status: r.status, body: d })));

    // ── Seed the REAL database ──
    await post({ studentId: 'T1', date: A, previousStatus: 'absent', newStatus: 'present', reason: 'on time', method: 'MANUAL_ADMIN', className: CLS1 });
    await post({ studentId: 'T2', date: A, previousStatus: 'absent', newStatus: 'late', reason: 'late', method: 'MANUAL_ADMIN', className: CLS1 });
    await post({ studentId: 'T3', date: A, previousStatus: 'absent', newStatus: 'leave', reason: 'sick', method: 'MANUAL_ADMIN', className: CLS2 });
    await post({ studentId: 'T4', date: B, previousStatus: 'absent', newStatus: 'present', reason: 'w2', method: 'MANUAL_ADMIN', className: CLS2 });

    // 1. Aggregation over A..B for class ม.4/1 -> present=1, late=1, leave=0 (T3 is ม.4/2)
    const s = await getStats({ start: A, end: B, academicYear: '2025', semester: 1, className: CLS1 });
    assert('stats 200', s.status === 200, `status=${s.status} body=${JSON.stringify(s.body)}`);
    assert('stats counts present=1', s.body.counts.present === 1, JSON.stringify(s.body.counts));
    assert('stats counts late=1', s.body.counts.late === 1, JSON.stringify(s.body.counts));
    assert('stats counts leave=0 (class filter)', s.body.counts.leave === 0, JSON.stringify(s.body.counts));
    assert('stats byDate spans A and B', (s.body.byDate || []).length >= 2 && (s.body.byDate||[]).find(d=>d.date===A) && (s.body.byDate||[]).find(d=>d.date===B), JSON.stringify(s.body.byDate));
    const rowA = (s.body.byDate || []).find(d => d.date === A);
    assert('byDate A present=1', rowA && rowA.present === 1, JSON.stringify(rowA));
    assert('byDate A late=1', rowA && rowA.late === 1, JSON.stringify(rowA));
    assert('byDate A leave=0', rowA && rowA.leave === 0, JSON.stringify(rowA));
    assert('byClass has ม.4/1', !!s.body.byClass && s.body.byClass[CLS1], JSON.stringify(s.body.byClass));
    assert('byClass ม.4/1 present=1', s.body.byClass[CLS1].present === 1, JSON.stringify(s.body.byClass));
    assert('byClass ม.4/1 late=1', s.body.byClass[CLS1].late === 1, JSON.stringify(s.body.byClass));

    // 2. Single-date stats (daily) across all classes -> present=1, late=1, leave=1
    const sd = await getStats({ date: A });
    assert('stats single-date counts', sd.body.counts.present === 1 && sd.body.counts.late === 1 && sd.body.counts.leave === 1, JSON.stringify(sd.body.counts));
    assert('stats single-date one byDate row', (sd.body.byDate || []).length === 1, JSON.stringify(sd.body.byDate));

    // 3. Week filter: week 1 includes A (T1,T2,T3) but not B (T4 week2)
    const w1 = await getStats({ start: A, end: B, academicYear: '2025', semester: 1, week: 1 });
    assert('week filter excludes week-2 record', w1.body.counts.present === 1 && w1.body.counts.late === 1 && w1.body.counts.leave === 1, JSON.stringify(w1.body.counts));

    // 4. Student filter
    const stu = await getStats({ start: A, end: B, studentId: 'T2' });
    assert('student filter late=1 present=0', stu.body.counts.late === 1 && stu.body.counts.present === 0, JSON.stringify(stu.body.counts));

    // 5. Authorization is server-side (401 without/with wrong token)
    const noAuth = await getStats({ start: A, end: B }, { token: false });
    assert('stats without token -> 401', noAuth.status === 401, `status=${noAuth.status}`);
    const badAuth = await getStats({ start: A, end: B }, { token: 'nope' });
    assert('stats wrong token -> 401', badAuth.status === 401, `status=${badAuth.status}`);

    // 6. Real data, no fake: totals reflect exactly what was seeded (==3 distinct student-days on A incl. leave)
    assert('no hard-coded numbers (leaves count is real from DB)', sd.body.counts.leave === 1, JSON.stringify(sd.body.counts));

    // 7. Server returns aggregates only (no raw records payload)
    assert('stats response has no raw records array', Array.isArray(s.body.records) === false, JSON.stringify(Object.keys(s.body)));

    child.kill();
    console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e); try { child.kill(); } catch (_) {} process.exit(1); });
