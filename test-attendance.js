'use strict';
/*
 * server/test-attendance.js — STEP 9 validation harness.
 * Spawns server/attendance-service.js in an isolated temp dir with a test token
 * and exercises the REAL database flow: server-side validation (including
 * previousStatus / old-status verification), correction/upsert (not blind
 * duplicate), absent removal, leave creation, auth, audit, historical
 * integrity, and on-disk persistence.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IN_SERVER = path.basename(__dirname) === 'server';
const SVC_ROOT = IN_SERVER ? path.join(__dirname, '..') : __dirname;
const SVC_PREFIX = IN_SERVER ? 'server/' : '';

const TOKEN = 'test-attendance-token-456';
const PORT = 3088;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'att-db-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

let pass = 0, fail = 0;
function assert(name, cond, extra = '') {
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

const A = '2025-05-05'; // week ~1
const B = '2025-06-06'; // week ~5
const C = '2025-08-08'; // week ~14
const OTHER = '2025-07-07'; // a week with no roster entry for this student

(async () => {
    for (let i = 0; i < 50 && !started; i++) await delay(100);
    if (!started) { console.error('server did not start'); process.exit(1); }

    const base = `http://127.0.0.1:${PORT}`;
    const authHeaders = (t = TOKEN) => ({ Authorization: `Bearer ${t}` });
    const post = (payload, opts = {}) => {
        const headers = { 'Content-Type': 'application/json', ...(opts.token === false ? {} : authHeaders(opts.token)) };
        return fetch(base + '/api/attendance/correction', { method: 'POST', headers, body: JSON.stringify(payload) }).then(r => r.json().catch(() => ({})).then(d => ({ status: r.status, body: d })));
    };
    const get = (query = '', opts = {}) => {
        const headers = opts.token === false ? {} : authHeaders(opts.token);
        return fetch(base + '/api/attendance' + (query ? '?' + query : ''), { headers })
            .then(r => r.json().catch(() => ({})).then(d => ({ status: r.status, body: d })));
    };
    const getAudit = (query = '', opts = {}) => {
        const headers = opts.token === false ? {} : authHeaders(opts.token);
        const url = query ? (base + '/api/audit?' + query) : (base + '/api/audit?limit=500');
        return fetch(url, { headers })
            .then(r => r.json().catch(() => ({})).then(d => ({ status: r.status, body: d })));
    };

    // 1. correction/upsert: same student+date must NOT create a second record
    let r = await post({ studentId: 'S1', date: A, previousStatus: 'absent', newStatus: 'present', reason: 'เข้าแถวแล้ว', method: 'MANUAL_ADMIN' });
    assert('correction present -> ok', r.status === 200 && r.body.ok === true, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert('correction created action', r.body.action === 'created', `body=${JSON.stringify(r.body)}`);
    let r2 = await post({ studentId: 'S1', date: A, previousStatus: 'present', newStatus: 'late', reason: 'แก้เป็นมาสาย', method: 'MANUAL_ADMIN' });
    assert('correction late updates (no dup) -> ok', r2.status === 200 && r2.body.ok === true, `status=${r2.status} body=${JSON.stringify(r2.body)}`);
    assert('correction updated action (not created)', r2.body.action === 'updated', `body=${JSON.stringify(r2.body)}`);
    const listed = await get('date=' + A);
    assert('no duplicate attendance record (1 row for S1 on A)', listed.body.attendance.length === 1, `got=${listed.body.attendance.length}`);

    // 2. student can exist in multiple weeks
    await post({ studentId: 'S2', date: A, previousStatus: 'absent', newStatus: 'present', reason: 'w1' });
    await post({ studentId: 'S2', date: B, previousStatus: 'absent', newStatus: 'present', reason: 'w5' });
    await post({ studentId: 'S2', date: C, previousStatus: 'absent', newStatus: 'present', reason: 'w14' });
    const multi = await get('studentId=S2');
    assert('student exists in multiple weeks', multi.body.attendance.length === 3, `got=${multi.body.attendance.length}`);

    // 3. student can be absent from a week (no record)
    const absentWeek = await get('studentId=S2&date=' + OTHER);
    assert('student absent from a week (empty)', absentWeek.body.attendance.length === 0, `got=${absentWeek.body.attendance.length}`);

    // 4. removing (absent) does not delete OTHER students / attendance remains intact
    await post({ studentId: 'S3', date: A, previousStatus: 'absent', newStatus: 'present', reason: 'keep me' });
    await post({ studentId: 'S4', date: A, previousStatus: 'absent', newStatus: 'present', reason: 'also keep' });
    const beforeA = (await get('date=' + A)).body.attendance.length;
    r = await post({ studentId: 'S3', date: A, previousStatus: 'present', newStatus: 'absent', reason: 'ขาดจริง', method: 'MANUAL_ADMIN' });
    assert('absent correction -> ok', r.status === 200 && r.body.ok === true, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert('absent correction removed record (action removed)', r.body.action === 'removed', `body=${JSON.stringify(r.body)}`);
    const afterA = await get('date=' + A);
    const stillPresent = afterA.body.attendance.find(x => x.studentId === 'S4');
    assert('S4 attendance remains intact after removing S3', !!stillPresent, JSON.stringify(afterA.body));
    assert('one fewer record on date A', afterA.body.attendance.length === beforeA - 1, `before=${beforeA} after=${afterA.body.attendance.length}`);

    // 5. historical integrity: editing Week B must not modify Week A
    const aBefore = (await get('date=' + A)).body.attendance.find(x => x.studentId === 'S2');
    await post({ studentId: 'S2', date: B, previousStatus: 'present', newStatus: 'late', reason: 'edit week B only' });
    const aAfter = (await get('date=' + A)).body.attendance.find(x => x.studentId === 'S2');
    assert('Week A record unchanged after editing Week B', JSON.stringify(aBefore) === JSON.stringify(aAfter), `before=${JSON.stringify(aBefore)} after=${JSON.stringify(aAfter)}`);

    // 6. leave creation (and leave clears an EXISTING attendance for that day)
    await post({ studentId: 'S5', date: C, previousStatus: 'absent', newStatus: 'present', reason: 'มาแล้ว' });
    r = await post({ studentId: 'S5', date: C, previousStatus: 'present', newStatus: 'leave', reason: 'สายทำงาน', method: 'MANUAL_ADMIN' });
    assert('leave correction -> ok', r.status === 200 && r.body.ok === true, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert('leave correction action=leave', r.body.action === 'leave', `body=${JSON.stringify(r.body)}`);
    assert('leave record has approved status', r.body.leave && r.body.leave.status === 'approved', JSON.stringify(r.body));
    const cAfter = await get('date=' + C + '&studentId=S5');
    assert('leave replaces (clears) existing attendance for that date', cAfter.body.attendance.length === 0, JSON.stringify(cAfter.body));

    // 7. authorization: must be server-side
    r = await post({ studentId: 'S6', date: A, previousStatus: 'absent', newStatus: 'present', reason: 'x' }, { token: false });
    assert('correction without token -> 401', r.status === 401, `status=${r.status}`);
    r = await post({ studentId: 'S6', date: A, previousStatus: 'absent', newStatus: 'present', reason: 'x' }, { token: 'wrong-token' });
    assert('correction wrong token -> 401', r.status === 401, `status=${r.status}`);
    const g = await get('date=' + A, { token: false });
    assert('list without token -> 401', g.status === 401, `status=${g.status}`);

    // 8. server-side validation
    r = await post({ studentId: 'S1', date: 'not-a-date', previousStatus: 'absent', newStatus: 'present', reason: 'x' });
    assert('invalid date -> 400', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);
    r = await post({ studentId: 'S1', date: A, previousStatus: 'absent', newStatus: 'sick', reason: 'x' });
    assert('invalid newStatus -> 400', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);
    r = await post({ studentId: 'S1', date: A, previousStatus: 'absent', newStatus: 'present', reason: '   ' });
    assert('missing reason -> 400', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);
    r = await post({ studentId: 'S1', date: A, previousStatus: 'absent', newStatus: 'present', reason: 'bad method', method: 'TELEPORT' });
    assert('invalid method -> 400', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 8b. STEP 7: week validation respects education level
    // ปวช. allows weeks 1-18; ปวส. allows weeks 1-15.
    r = await post({ studentId: 'S120', date: A, previousStatus: 'absent', newStatus: 'present', reason: 'ปวช week ok', className: 'ปวช.1', week: 18, academicYear: '2025', semester: 1 });
    assert('ปวช. week 18 -> 200', r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    r = await post({ studentId: 'S120', date: A, newStatus: 'present', reason: 'ปวส week 16 rejected', className: 'ปวส.1', week: 16, academicYear: '2025', semester: 2 });
    assert('ปวส. week 16 -> 400', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);
    r = await post({ studentId: 'S121', date: A, previousStatus: 'absent', newStatus: 'present', reason: 'ปวช week 19 rejected', className: 'ปวช.1', week: 19, academicYear: '2025', semester: 1 });
    assert('ปวช. week 19 -> 400', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 9. STEP 1: previousStatus is now OPTIONAL.
    // When omitted the server treats the request as a CREATE (no concurrency check)
    // — the client is asserting "no record exists on my side". This replaces the old
    // "fake previousStatus=absent" pattern that conflated NO-RECORD with EXPLICIT-ABSENT.
    r = await post({ studentId: 'S99', date: OTHER, newStatus: 'present', reason: 'create without previousStatus' });
    assert('missing previousStatus -> 200 (create)', r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert('missing previousStatus action=created', r.body.action === 'created', `body=${JSON.stringify(r.body)}`);
    // invalid previousStatus string (when provided) is still rejected
    r = await post({ studentId: 'S1', date: A, previousStatus: 'maybe', newStatus: 'present', reason: 'bad previousStatus' });
    assert('invalid previousStatus -> 400', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 10. STEP 9: optimistic concurrency — stale previousStatus causes 409 conflict
    // S1 on date A is currently 'late' (updated in step 1). Send with stale 'present'.
    r = await post({ studentId: 'S1', date: A, previousStatus: 'present', newStatus: 'absent', reason: 'stale check' });
    assert('stale previousStatus -> 409 conflict', r.status === 409, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert('409 returns current previousStatus', r.body.previousStatus === 'late', `body=${JSON.stringify(r.body)}`);
    assert('409 returns hasRecord=true for existing record', r.body.hasRecord === true, `body=${JSON.stringify(r.body)}`);
    // Verify record was NOT modified
    const afterConflict = await get('date=' + A + '&studentId=S1');
    assert('S1 record unchanged after 409', afterConflict.body.attendance.length === 1, JSON.stringify(afterConflict.body));

    // 11. Correction with correct previousStatus succeeds -> conflict resolved
    r = await post({ studentId: 'S1', date: A, previousStatus: 'late', newStatus: 'present', reason: 'fix back to present' });
    assert('correct previousStatus -> 200', r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert('correct previousStatus action=updated', r.body.action === 'updated', `body=${JSON.stringify(r.body)}`);

    // 12. audit trail recorded with all required fields
    const audit = await getAudit();
    assert('audit endpoint ok for admin', audit.status === 200, `status=${audit.status}`);
    assert('audit has entries', (audit.body.audit || []).length > 0, `body=${JSON.stringify(audit.body)}`);
    const one = audit.body.audit.find(e => e.studentId === 'S2' && e.date === B);
    assert('audit entry records old+new+reason', one && one.previousStatus && one.newStatus && one.reason, JSON.stringify(one));
    assert('audit entry records admin + time', one && one.changedBy && one.timestamp, JSON.stringify(one));

    // 12b. STEP 10: audit entry extended with recordId + scope fields
    assert('audit entry has recordId', !!one && one.recordId, JSON.stringify(one));
    assert('audit entry has className', typeof one.className === 'string', JSON.stringify(one));
    assert('audit entry has week', typeof one.week === 'number', JSON.stringify(one));
    assert('audit entry has academicYear', typeof one.academicYear === 'string', JSON.stringify(one));
    assert('audit entry has semester', typeof one.semester === 'number', JSON.stringify(one));
    assert('audit entry has action', one.action === 'attendance_correction', JSON.stringify(one));

    // 12c. STEP 10: audit does NOT store biometric data or secrets
    const auditStr = JSON.stringify(audit.body);
    assert('audit has no descriptors/embedding', !/descriptor|embedding/i.test(auditStr), 'biometric data leaked in audit');
    assert('audit has no tokens', !auditStr.includes(TOKEN), 'token leaked in audit');
    assert('audit has no admin token field', !auditStr.includes('admin_token'), 'admin token field in audit');

    // 12d. STEP 10: audit filtering by studentId
    const auditS5 = await getAudit('studentId=S5');
    assert('audit filter by studentId returns S5 entries only', (auditS5.body.audit || []).every(e => e.studentId === 'S5'), JSON.stringify(auditS5.body));

    // 12e. STEP 10: audit filtering by date
    const auditA = await getAudit('date=' + A);
    assert('audit filter by date returns only date A entries', (auditA.body.audit || []).every(e => e.date === A), JSON.stringify(auditA.body));

    // 12f. STEP 10: audit filtering by admin (changedBy)
    const auditAdmin = await getAudit('admin=admin');
    assert('audit filter by admin returns admin entries', (auditAdmin.body.audit || []).every(e => e.changedBy === 'admin'), JSON.stringify(auditAdmin.body));

    // 12g. STEP 10: audit filtering by action
    const auditCorr = await getAudit('action=attendance_correction');
    assert('audit filter by action returns correction entries', (auditCorr.body.audit || []).every(e => e.action === 'attendance_correction'), JSON.stringify(auditCorr.body));

    // 12h. STEP 10: audit without auth -> 401
    const auditNoAuth = await getAudit('', { token: false });
    assert('audit without token -> 401', auditNoAuth.status === 401, `status=${auditNoAuth.status}`);

    // 13. persistence: the real DB file on disk reflects the corrections
    const attFile = path.join(dataDir, 'attendance.json');
    const onDisk = JSON.parse(fs.readFileSync(attFile, 'utf8'));
    assert('attendance.json persisted on disk', Array.isArray(onDisk) && onDisk.length > 0, `len=${onDisk.length}`);
    assert('S3 removed on disk (no S3 on A)', !onDisk.some(r => r.studentId === 'S3' && r.date === A), JSON.stringify(onDisk));
    assert('S4 persisted on disk', onDisk.some(r => r.studentId === 'S4' && r.date === A), JSON.stringify(onDisk));

    // 14. "removing roster does not delete student": server has no student collection,
    //     so removing a membership never deletes a student — verify S2 still present on A & B after ops.
    const s2A = await get('date=' + A + '&studentId=S2');
    const s2B = await get('date=' + B + '&studentId=S2');
    assert('S2 still enrolled on A after edits', s2A.body.attendance.length === 1, JSON.stringify(s2A.body));
    assert('S2 still enrolled on B after edits', s2B.body.attendance.length === 1, JSON.stringify(s2B.body));

    child.kill();
    console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e); try { child.kill(); } catch (_) {} process.exit(1); });
