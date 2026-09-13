// STEP 4 — Class database model tests (pure, no browser).
//
// Verifies the core invariants required by STEP 4:
//   - classes are validated (classId, code, name, createdAt)
//   - deriveClasses extracts unique codes from student.year (safe migration)
//   - duplicate prevention on classId and code
//   - removeClass only removes the class definition, never students/attendance/leave
//   - historical integrity: editing class list does not touch student records
const assert = require('assert');
const path = require('path');
const IN_SERVER = path.basename(__dirname) === 'server';
const ClassModel = require(IN_SERVER ? '../class-model.js' : './class-model.js');

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); console.log('PASS ' + name); pass++; }
    catch (e) { console.log('FAIL ' + name + ' — ' + (e && e.message)); fail++; }
}

// Independent "permanent" collections to assert they are never touched.
const students = [
    { id: 'S1', name: 'นาย ก', year: 'ม.4/1', descriptors: [[0.1], [0.2]] },
    { id: 'S2', name: 'นาง ข', year: 'ม.4/2', descriptors: [[0.3]] },
    { id: 'S3', name: 'นาง ฃ', year: 'ม.4/1', descriptors: [[0.4]] },
];
const attendance = [
    { id: 'A1', studentId: 'S1', date: '2025-01-01', time: '07:45', year: 'ม.4/1' },
    { id: 'A2', studentId: 'S2', date: '2025-01-01', time: '08:10', year: 'ม.4/2' },
];

const snap = () => ({
    students:   students.map(s => Object.assign({}, s, { descriptors: s.descriptors.slice() })),
    attendance: attendance.map(a => Object.assign({}, a)),
});

function validClass(overrides) {
    return Object.assign({
        classId: 'cls_' + Math.random().toString(36).slice(2),
        code: 'ม.4/1',
        name: 'ม.4/1',
        createdAt: 1700000000000,
    }, overrides || {});
}

check('validateClass accepts a well-formed record', () => {
    assert.strictEqual(ClassModel.validateClass(validClass()), true);
});

check('validateClass rejects missing classId', () => {
    assert.strictEqual(ClassModel.validateClass(validClass({ classId: '' })), false);
});

check('validateClass rejects missing code', () => {
    assert.strictEqual(ClassModel.validateClass(validClass({ code: '' })), false);
});

check('validateClass rejects missing name', () => {
    assert.strictEqual(ClassModel.validateClass(validClass({ name: '' })), false);
});

check('validateClass rejects missing/invalid createdAt', () => {
    assert.strictEqual(ClassModel.validateClass(validClass({ createdAt: 'now' })), false);
    assert.strictEqual(ClassModel.validateClass(validClass({ createdAt: undefined })), false);
});

check('validateClass rejects non-object', () => {
    assert.strictEqual(ClassModel.validateClass(null), false);
    assert.strictEqual(ClassModel.validateClass('ม.4/1'), false);
    assert.strictEqual(ClassModel.validateClass(42), false);
});

check('deriveClasses extracts unique codes from student.year', () => {
    const derived = ClassModel.deriveClasses(students);
    assert.strictEqual(derived.length, 2, 'S1 and S3 share ม.4/1, S2 is ม.4/2 -> 2 unique classes');
    const codes = derived.map(c => c.code).sort();
    assert.deepStrictEqual(codes, ['ม.4/1', 'ม.4/2']);
});

check('deriveClasses does not modify student records (safe migration)', () => {
    const before = snap();
    ClassModel.deriveClasses(students);
    const after = snap();
    assert.deepStrictEqual(before.students, after.students);
    assert.deepStrictEqual(before.attendance, after.attendance);
});

check('deriveClasses assigns unique classIds', () => {
    const derived = ClassModel.deriveClasses(students);
    const ids = derived.map(c => c.classId);
    assert.strictEqual(new Set(ids).size, ids.length);
});

check('deriveClasses handles empty student list', () => {
    const derived = ClassModel.deriveClasses([]);
    assert.strictEqual(derived.length, 0);
});

check('deriveClasses handles students with empty/missing year', () => {
    const mixed = [{ id: 'X', year: '' }, { id: 'Y', year: 'ม.1/1' }, { id: 'Z', year: '  ม.1/1  ' }];
    const derived = ClassModel.deriveClasses(mixed);
    assert.strictEqual(derived.length, 1);
    assert.strictEqual(derived[0].code, 'ม.1/1');
});

check('addClass adds a valid class', () => {
    let list = [];
    const snapshot = list.slice();
    const r = ClassModel.addClass(list, validClass());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reason, 'added');
    assert.strictEqual(r.list.length, 1);
    assert.deepStrictEqual(list, snapshot); // input not mutated
});

check('addClass rejects invalid record', () => {
    let list = [];
    const r = ClassModel.addClass(list, { classId: 'x', code: '' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'invalid');
    assert.strictEqual(r.list.length, 0);
});

check('addClass rejects duplicate by classId', () => {
    const c = validClass();
    let list = [];
    let r = ClassModel.addClass(list, c);
    assert.strictEqual(r.ok, true);
    r = ClassModel.addClass(r.list, c);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'duplicate');
});

check('addClass rejects duplicate by code', () => {
    let list = [];
    let r = ClassModel.addClass(list, validClass({ classId: 'a1', code: 'ม.4/1' }));
    assert.strictEqual(r.ok, true);
    r = ClassModel.addClass(r.list, validClass({ classId: 'a2', code: 'ม.4/1' }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'duplicate');
});

check('removeClass removes only the class definition', () => {
    const before = snap();
    let list = [validClass({ code: 'ม.4/1' }), validClass({ code: 'ม.4/2' })];
    const res = ClassModel.removeClass(list, 0);
    assert.strictEqual(res.removed, true);
    assert.strictEqual(res.list.length, 1);
    const after = snap();
    // permanent collections untouched
    assert.deepStrictEqual(before.students, after.students);
    assert.deepStrictEqual(before.attendance, after.attendance);
});

check('removeClass rejects out-of-bounds index', () => {
    let list = [validClass()];
    const res = ClassModel.removeClass(list, 5);
    assert.strictEqual(res.removed, false);
    assert.strictEqual(res.list.length, 1);
});

check('findClasses queries by code', () => {
    const list = [validClass({ code: 'ม.4/1' }), validClass({ code: 'ม.4/2' })];
    const found = ClassModel.findClasses(list, { code: 'ม.4/2' });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].code, 'ม.4/2');
});

check('reconcileClasses adds new classes from students without deleting existing', () => {
    const before = snap();
    let classes = [validClass({ classId: 'keep1', code: 'ม.4/1' })];
    const result = ClassModel.reconcileClasses(classes, students);
    // derived has ม.4/1 and ม.4/2; ม.4/1 already exists -> should add ม.4/2 only
    const codes = result.list.map(c => c.code).sort();
    assert.deepStrictEqual(codes, ['ม.4/1', 'ม.4/2']);
    const existing = result.list.find(c => c.classId === 'keep1');
    assert.ok(existing, 'existing class record preserved (not replaced)');
    const added = result.added;
    assert.strictEqual(added, 1, 'one new class added');
    assert.strictEqual(result.removed.length, 0);
    // permanent collections untouched
    const after = snap();
    assert.deepStrictEqual(before.students, after.students);
    assert.deepStrictEqual(before.attendance, after.attendance);
});

check('reconcileClasses detects removed classes (no students)', () => {
    const orphanClass = validClass({ classId: 'gone', code: 'ม.9/9' });
    const classes = [validClass({ code: 'ม.4/1' }), orphanClass];
    const result = ClassModel.reconcileClasses(classes, students);
    assert.strictEqual(result.removed.length, 1);
    assert.strictEqual(result.removed[0].code, 'ม.9/9');
    // removed class only flagged, NOT deleted from result.list unless called with removal
    const codes = result.list.map(c => c.code);
    assert.ok(codes.indexOf('ม.9/9') === -1, 'orphan class removed from reconciled list');
});

check('studentCountForClass returns correct counts', () => {
    assert.strictEqual(ClassModel.studentCountForClass(students, 'ม.4/1'), 2);
    assert.strictEqual(ClassModel.studentCountForClass(students, 'ม.4/2'), 1);
    assert.strictEqual(ClassModel.studentCountForClass(students, 'ม.5/1'), 0);
    assert.strictEqual(ClassModel.studentCountForClass([], 'ม.4/1'), 0);
});

check('historical integrity: class operations never touch student descriptors', () => {
    const before = snap();
    const derived = ClassModel.deriveClasses(students);
    let list = [];
    let r = ClassModel.addClass(list, derived[0]);
    r = ClassModel.addClass(r.list, derived[1]);
    ClassModel.removeClass(r.list, 0);
    const after = snap();
    assert.deepStrictEqual(before.students, after.students, 'students unchanged');
    assert.deepStrictEqual(before.attendance, after.attendance, 'attendance unchanged');
});

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
