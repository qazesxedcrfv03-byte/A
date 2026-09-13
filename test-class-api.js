'use strict';
/*
 * server/test-class-api.js — STEP 5 validation harness.
 * Spawns server/attendance-service.js in an isolated temp dir with a test token
 * and exercises the REAL database flow for class management:
 *   - listing classes (empty + populated)
 *   - creating a class (success + duplicate + validation)
 *   - updating a class (name + code)
 *   - deleting a class (students preserved, assignments removed)
 *   - assigning a student to a class
 *   - retrieving students by class
 *   - unassigning a student (student record never deleted)
 *   - authorization (401 without/wrong token)
 -   - server-side validation (invalid payloads)
 -   - persistence to classes.json + class_students.json on disk
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IN_SERVER = path.basename(__dirname) === 'server';
const SVC_ROOT = IN_SERVER ? path.join(__dirname, '..') : __dirname;
const SVC_PREFIX = IN_SERVER ? 'server/' : '';

const TOKEN = 'test-class-api-token-999';
const PORT = 3092;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'class-api-'));
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

const base = `http://127.0.0.1:${PORT}`;
const authHeaders = (t = TOKEN) => ({ Authorization: `Bearer ${t}` });
const jsonHeaders = (opts = {}) => ({ 'Content-Type': 'application/json', ...(opts.token === false ? {} : authHeaders(opts.token)) });

const api = (method, path, body, opts = {}) => {
    const headers = jsonHeaders(opts);
    const p = fetch(base + path, {
        method: method,
        headers: headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    return p.then(r => r.json().catch(() => ({})).then(d => ({ status: r.status, body: d })));
};

(async () => {
    for (let i = 0; i < 50 && !started; i++) await delay(100);
    if (!started) { console.error('server did not start'); process.exit(1); }

    // 1. List classes on fresh DB -> empty
    let r = await api('GET', '/api/classes');
    assert('list classes on fresh DB -> 200, empty', r.status === 200 && Array.isArray(r.body.classes) && r.body.classes.length === 0, JSON.stringify(r.body));

    // 2. Create a class
    const CREATED = await api('POST', '/api/classes', { code: 'ม.4/1', name: 'ประชานมครั่งหนึ่ง', admin: 'admin' });
    assert('create class -> 201', CREATED.status === 201, `status=${CREATED.status} body=${JSON.stringify(CREATED.body)}`);
    assert('create returns classId', !!CREATED.body.classId, JSON.stringify(CREATED.body));
    assert('create returns code', CREATED.body.code === 'ม.4/1', JSON.stringify(CREATED.body));
    assert('create returns studentCount 0', CREATED.body.studentCount === 0, JSON.stringify(CREATED.body));
    const CLASS_ID = CREATED.body.classId;

    // 3. Create duplicate class -> 409
    r = await api('POST', '/api/classes', { code: 'ม.4/1', name: 'dup' });
    assert('duplicate class code -> 409', r.status === 409, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 4. Create second class
    const C2 = await api('POST', '/api/classes', { code: 'ม.4/2', name: 'ประชานมครั่งสอง' });
    assert('create second class -> 201', C2.status === 201, `status=${C2.status} body=${JSON.stringify(C2.body)}`);
    const C2_ID = C2.body.classId;

    // 5. Create invalid class (missing code) -> 400
    r = await api('POST', '/api/classes', { name: 'no code' });
    assert('create without code -> 400', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 6. List classes now returns 2
    r = await api('GET', '/api/classes');
    assert('list classes returns 2', r.status === 200 && r.body.classes.length === 2, JSON.stringify(r.body));

    // 7. List classes filtered by code
    r = await api('GET', '/api/classes?code=' + encodeURIComponent('ม.4/1'));
    assert('list classes filtered by code -> 1', r.status === 200 && r.body.classes.length === 1, JSON.stringify(r.body));

    // 8. Update class name (PUT)
    r = await api('PUT', '/api/classes/' + CLASS_ID, { name: 'ชั้น ม.4/1 (แก้ไขแล้ว)' });
    assert('update class name -> 200', r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert('update returns new name', r.body.name === 'ชั้น ม.4/1 (แก้ไขแล้ว)', JSON.stringify(r.body));

    // 9. Update class code (PUT)
    r = await api('PUT', '/api/classes/' + CLASS_ID, { code: 'ม.4/1-edit' });
    assert('update class code -> 200', r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert('update returns new code', r.body.code === 'ม.4/1-edit', JSON.stringify(r.body));

    // 10. Update non-existent class -> 404
    r = await api('PUT', '/api/classes/nonexistent', { name: 'x' });
    assert('update non-existent class -> 404', r.status === 404, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 11. Assign student to class
    r = await api('POST', '/api/classes/' + CLASS_ID + '/students', { studentId: 'S1', studentName: 'นาย ก' });
    assert('assign student to class -> 201', r.status === 201, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert('assign returns studentId', r.body.studentId === 'S1', JSON.stringify(r.body));

    r = await api('POST', '/api/classes/' + CLASS_ID + '/students', { studentId: 'S2', studentName: 'นาง ข' });
    assert('assign second student -> 201', r.status === 201);

    // 12. Assign same student again (upsert, not duplicate)
    r = await api('POST', '/api/classes/' + CLASS_ID + '/students', { studentId: 'S1', studentName: 'นาย กแก้ไข' });
    assert('re-assign same student -> 201 (upsert)', r.status === 201, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 13. Assign to non-existent class -> 404
    r = await api('POST', '/api/classes/nonexistent/students', { studentId: 'S3' });
    assert('assign to non-existent class -> 404', r.status === 404, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 14. Assign with invalid studentId -> 400
    r = await api('POST', '/api/classes/' + CLASS_ID + '/students', { studentId: '', studentName: 'x' });
    assert('assign with empty studentId -> 400', r.status === 400, `status=${r.status}`);

    // 15. List students in class
    r = await api('GET', '/api/classes/' + CLASS_ID + '/students');
    assert('list students in class -> 200', r.status === 200 && r.body.students.length === 2, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert('list students includes S1', r.body.students.some(s => s.studentId === 'S1'), JSON.stringify(r.body.students));

    // 16. List students in class via PUT-style GET (3 segments, GET)
    r = await api('GET', '/api/classes/' + C2_ID);
    assert('GET class with 3 segments returns students (empty)', r.status === 200 && r.body.students.length === 0, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 17. Unassign student
    r = await api('DELETE', '/api/classes/' + CLASS_ID + '/students/S1');
    assert('unassign student -> 200', r.status === 200 && r.body.unassigned === true, `status=${r.status} body=${JSON.stringify(r.body)}`);
    // Student not deleted from any other collection — verify by re-checking
    r = await api('GET', '/api/classes/' + CLASS_ID + '/students');
    assert('after unassign, 1 student remaining', r.body.students.length === 1, JSON.stringify(r.body.students));

    // 18. Unassign non-existent assignment -> 404
    r = await api('DELETE', '/api/classes/' + CLASS_ID + '/students/S99');
    assert('unassign non-existent assignment -> 404', r.status === 404, `status=${r.status}`);

    // 19. Delete class (assignments removed, student records NOT deleted)
    r = await api('DELETE', '/api/classes/' + C2_ID);
    assert('delete class -> 200', r.status === 200 && r.body.deleted === true, `status=${r.status} body=${JSON.stringify(r.body)}`);
    r = await api('GET', '/api/classes/' + C2_ID + '/students');
    assert('deleted class returns 404 on student list', r.status === 404, `status=${r.status}`);

    // 20. Authorization: all class endpoints require Bearer token
    r = await api('GET', '/api/classes', null, { token: false });
    assert('list classes without token -> 401', r.status === 401, `status=${r.status}`);
    r = await api('POST', '/api/classes', { code: 'ม.5/1' }, { token: false });
    assert('create class without token -> 401', r.status === 401, `status=${r.status}`);
    r = await api('PUT', '/api/classes/' + CLASS_ID, { name: 'x' }, { token: false });
    assert('update class without token -> 401', r.status === 401, `status=${r.status}`);
    r = await api('DELETE', '/api/classes/' + CLASS_ID, null, { token: false });
    assert('delete class without token -> 401', r.status === 401, `status=${r.status}`);
    r = await api('GET', '/api/classes/' + CLASS_ID + '/students', null, { token: false });
    assert('list class students without token -> 401', r.status === 401, `status=${r.status}`);
    r = await api('POST', '/api/classes/' + CLASS_ID + '/students', { studentId: 'S3' }, { token: false });
    assert('assign student without token -> 401', r.status === 401, `status=${r.status}`);
    r = await api('DELETE', '/api/classes/' + CLASS_ID + '/students/S2', null, { token: false });
    assert('unassign student without token -> 401', r.status === 401, `status=${r.status}`);

    // 21. Wrong token
    r = await api('GET', '/api/classes', null, { token: 'wrong-token' });
    assert('wrong token -> 401', r.status === 401, `status=${r.status}`);

    // 22. Invalid JSON body
    r = await fetch(base + '/api/classes', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: 'not json',
    }).then(resp => resp.json().catch(() => ({})).then(d => ({ status: resp.status, body: d })));
    assert('create class with invalid JSON -> 400', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 23. Persistence: data written to disk
    const classesFile = path.join(dataDir, 'classes.json');
    const studentsFile = path.join(dataDir, 'class_students.json');
    assert('classes.json persisted on disk', fs.existsSync(classesFile));
    assert('class_students.json persisted on disk', fs.existsSync(studentsFile));
    const onDiskClasses = JSON.parse(fs.readFileSync(classesFile, 'utf8'));
    assert('classes.json has 1 class (C2 deleted)', onDiskClasses.length === 1, `len=${onDiskClasses.length}`);
    const onDiskStudents = JSON.parse(fs.readFileSync(studentsFile, 'utf8'));
    assert('class_students.json has 1 student remaining (S2, S1 unassigned)', onDiskStudents.length === 1, `len=${onDiskStudents.length} body=${JSON.stringify(onDiskStudents)}`);

    // 24. Existing endpoints still work (no regression)
    const health = await fetch(base + '/health').then(r => r.json());
    assert('existing /health still works', health.ok === true, JSON.stringify(health));

    // 25. 404 for unknown routes
    r = await api('GET', '/api/unknown');
    assert('unknown route -> 404', r.status === 404, `status=${r.status}`);

    child.kill();
    console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e); try { child.kill(); } catch (_) {} process.exit(1); });
