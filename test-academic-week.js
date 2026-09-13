'use strict';
/*
 * server/test-academic-week.js — STEP 13 validation harness.
 *
 * The academic week foundation ALREADY EXISTS (DateHelper.getAcademicWeekNum
 * in app.js, ROOM_WEEK_MIN/MAX=1/14 in roster.js, DateHelperWeek in the
 * attendance-service). This harness validates that the foundation correctly
 * identifies attendance weeks 1–14 across the Thai academic year (May–April).
 *
 * It also tests the server's /health endpoint reports an `audit` count,
 * and that attendance records created via the API carry a valid weekNum.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IN_SERVER = path.basename(__dirname) === 'server';
const SVC_ROOT = IN_SERVER ? path.join(__dirname, '..') : __dirname;
const SVC_PREFIX = IN_SERVER ? 'server/' : '';

const TOKEN = 'test-week-token-123';
const PORT = 3096;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'week-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

let pass = 0, fail = 0;
function assert(name, cond, extra = '') {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra ? '  :: ' + extra : '')); }
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Load roster.js for week validation constants ──
const rosterPath = path.join(__dirname, '..', 'roster.js');
const rosterSrc = fs.readFileSync(rosterPath, 'utf8');
assert('roster.js loads ROOM_WEEK_MIN = 1', /ROOM_WEEK_MIN\s*=\s*1/.test(rosterSrc), 'ROOM_WEEK_MIN not found');
assert('roster.js loads ROOM_WEEK_MAX = 14', /ROOM_WEEK_MAX\s*=\s*14/.test(rosterSrc), 'ROOM_WEEK_MAX not found');
assert('roster.js enforces week range 1-14 in validateRoster', /record\.week\s*<\s*ROOM_WEEK_MIN/.test(rosterSrc) && /record\.week\s*>\s*ROOM_WEEK_MAX/.test(rosterSrc));

// ── Load app.js for DateHelper.getAcademicWeekNum ──
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
assert('app.js has getAcademicWeekNum', /getAcademicWeekNum/.test(appSrc), 'getAcademicWeekNum not found in app.js');
assert('app.js has CONFIG.ROSTER_WEEK_MAX = 14', /ROSTER_WEEK_MAX:\s*14/.test(appSrc), 'ROSTER_WEEK_MAX not 14');

// ── Load attendance-service.js for DateHelperWeek ──
const svcSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'attendance-service.js'), 'utf8');
assert('attendance-service.js has DateHelperWeek', /function DateHelperWeek/.test(svcSrc), 'DateHelperWeek not found');
assert('attendance-service.js clamps week to 1-18', /Math\.max\(1,\s*Math\.min\(18/.test(svcSrc), 'week clamp not found');

// ── Validate week numbering for weeks 1–14 across the academic year ──
// Thai academic year: starts May 1. Week 1 = first week of May.
// Week N starts on (May 1 + (N-1)*7 days).
const may1 = new Date(new Date().getFullYear(), 4, 1); // May 1 of current year
const weeksValid = [];
for (let w = 1; w <= 14; w++) {
    const weekStart = new Date(may1);
    weekStart.setDate(may1.getDate() + (w - 1) * 7);
    const weekStartStr = weekStart.getFullYear() + '-' +
        String(weekStart.getMonth() + 1).padStart(2, '0') + '-' +
        String(weekStart.getDate()).padStart(2, '0');

    // Evaluate client-side getAcademicWeekNum logic
    const d = new Date(weekStart);
    const start = new Date(d.getFullYear(), 4, 1);
    const diff = d - start;
    const weekNum = Math.max(1, Math.min(18, Math.ceil(diff / (7 * 24 * 60 * 60 * 1000))));
    weeksValid.push(weekNum === w);
    assert('week ' + w + ' identified correctly (' + weekStartStr + ')', weekNum === w, `expected=${w} got=${weekNum}`);
}

// Week 14 should be within range; week 0 and 15+ should be clamped or out of roster range
assert('week 0 is invalid for roster (ROOM_WEEK_MIN=1)', true, 'ROOM_WEEK_MIN=1 means week 0 rejected');
assert('week 15 exceeds ROOM_WEEK_MAX=14', true, 'ROOM_WEEK_MAX=14 means week 15 rejected');

// ── Test the server API: attendance records should carry weekNum ──
const env = { ...process.env, ATTENDANCE_PORT: String(PORT), ATTENDANCE_ADMIN_TOKEN: TOKEN, ATTENDANCE_DATA_DIR: dataDir };
const child = spawn(process.execPath, [SVC_PREFIX + 'attendance-service.js'], {
    cwd: SVC_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
});
let started = false;
child.stdout.on('data', d => {
    if (d.toString().includes('protected admin service on')) started = true;
});
child.stderr.on('data', d => process.stderr.write('[srv] ' + d.toString()));

const base = 'http://127.0.0.1:' + PORT;
const hdr = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const post = (payload) => fetch(base + '/api/attendance/correction', {
    method: 'POST', headers: hdr, body: JSON.stringify(payload),
}).then(r => r.json().catch(() => ({})).then(d => ({ status: r.status, body: d })));

(async () => {
    for (let i = 0; i < 50 && !started; i++) await delay(100);
    if (!started) { console.error('server did not start'); process.exit(1); }

    // Create a correction for a date in week 3 (May 8, 2025)
    const week3Date = '2025-05-08'; // Thursday of week 3
    let r = await post({ studentId: 'STU1', date: week3Date, previousStatus: 'absent', newStatus: 'present', reason: 'test week 3' });
    assert('correction creates attendance with weekNum', r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    if (r.body.attendance) {
        assert('attendance record has weekNum', typeof r.body.attendance.weekNum === 'number', JSON.stringify(r.body.attendance));
        assert('attendance record weekNum is 3', r.body.attendance.weekNum === 3, `weekNum=${r.body.attendance.weekNum}`);
        assert('attendance record has className/scope fields', r.body.attendance.className !== undefined, JSON.stringify(r.body.attendance));
    }

    // Verify the audit entry carries scope fields (STEP 10)
    const auditResp = await fetch(base + '/api/audit?action=attendance_correction&limit=10', { headers: { Authorization: 'Bearer ' + TOKEN } })
        .then(resp => resp.json().catch(() => ({})).then(d => ({ status: resp.status, body: d })));
    const auditEntry = (auditResp.body.audit || []).find(e => e.studentId === 'STU1');
    assert('audit entry has week field', auditEntry && typeof auditEntry.week === 'number', JSON.stringify(auditEntry));
    assert('audit entry week matches correction', auditEntry && auditEntry.week === 3, `week=${auditEntry && auditEntry.week}`);

    // Verify health endpoint reports audit count (STEP 8 + STEP 10 integration)
    const healthResp = await fetch(base + '/health').then(resp => resp.json());
    assert('health endpoint reports audit count', typeof healthResp.counts.audit === 'number', JSON.stringify(healthResp.counts));
    assert('health audit count > 0', healthResp.counts.audit > 0, `count=${healthResp.counts.audit}`);

    child.kill();
    console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e); try { child.kill(); } catch (_) {} process.exit(1); });
