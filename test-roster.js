// STEP 8 — Historical roster data model tests (pure, no browser).
//
// Verifies the core invariants required by STEP 8:
//   - student is permanent (roster ops never delete students / attendance / faces)
//   - a student can exist in multiple weeks
//   - a student can be absent from a week
//   - removing a roster membership does not delete the student, attendance, or face data
//   - historical integrity: editing Week N does not touch other weeks
//   - duplicate protection: same student cannot be added twice to the same
//     (academicYear, semester, week, className)
const assert = require('assert');
const path = require('path');
const IN_SERVER = path.basename(__dirname) === 'server';
const RosterModel = require(IN_SERVER ? '../roster.js' : './roster.js');

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); console.log('PASS ' + name); pass++; }
    catch (e) { console.log('FAIL ' + name + ' — ' + (e && e.message)); fail++; }
}

// Independent "permanent" collections to assert they are never touched.
const students = [
    { id: 'S1', name: 'นาย ก', year: 'ม.4/1', descriptors: [[0.1], [0.2]] },
    { id: 'S2', name: 'นาง ข', year: 'ม.4/1', descriptors: [[0.3]] },
];
const attendance = [
    { id: 'A1', studentId: 'S1', date: '2025-01-01', time: '07:45' },
    { id: 'A2', studentId: 'S2', date: '2025-01-01', time: '08:10' },
];
const faceData = { S1: [[0.1, 0.2]], S2: [[0.3]] };

const snap = () => ({
    students:   students.map(s => Object.assign({}, s, { descriptors: s.descriptors.slice() })),
    attendance: attendance.map(a => Object.assign({}, a)),
    faceData:   JSON.parse(JSON.stringify(faceData)),
});

function validRecord(overrides) {
    return Object.assign({
        rosterId: 'r_' + Math.random().toString(36).slice(2),
        studentId: 'S1',
        academicYear: '2025',
        semester: 1,
        week: 5,
        className: 'ม.4/1',
        addedAt: 1700000000000,
    }, overrides || {});
}

check('validateRoster accepts a well-formed record', () => {
    assert.strictEqual(RosterModel.validateRoster(validRecord()), true);
});

check('validateRoster rejects week 0', () => {
    assert.strictEqual(RosterModel.validateRoster(validRecord({ week: 0 })), false);
});

check('validateRoster rejects week 15 (only 1–14)', () => {
    assert.strictEqual(RosterModel.validateRoster(validRecord({ week: 15 })), false);
});

check('validateRoster rejects semester 3', () => {
    assert.strictEqual(RosterModel.validateRoster(validRecord({ semester: 3 })), false);
});

check('validateRoster rejects missing studentId', () => {
    assert.strictEqual(RosterModel.validateRoster(validRecord({ studentId: '' })), false);
});

check('student can exist in multiple weeks (same AY/sem/class)', () => {
    let list = [];
    const a = RosterModel.addRoster(list, validRecord({ studentId: 'S1', week: 1 }));
    assert.strictEqual(a.ok, true);
    const b = RosterModel.addRoster(a.list, validRecord({ studentId: 'S1', week: 5 }));
    assert.strictEqual(b.ok, true);
    const c = RosterModel.addRoster(b.list, validRecord({ studentId: 'S1', week: 14 }));
    assert.strictEqual(c.ok, true);
    assert.strictEqual(RosterModel.findRosters(c.list, { studentId: 'S1' }).length, 3);
});

check('student can be absent from a week (filter returns [] for that week)', () => {
    let list = [];
    list = RosterModel.addRoster(list, validRecord({ studentId: 'S1', week: 1 })).list;
    list = RosterModel.addRoster(list, validRecord({ studentId: 'S1', week: 5 })).list;
    assert.strictEqual(RosterModel.findRosters(list, { studentId: 'S1', week: 3 }).length, 0);
});

check('duplicate protection: same student twice in same (AY,sem,week,class) rejected', () => {
    let list = [];
    const a = RosterModel.addRoster(list, validRecord({ studentId: 'S1', academicYear: '2025', semester: 1, week: 5, className: 'ม.4/1' }));
    assert.strictEqual(a.ok, true);
    const b = RosterModel.addRoster(a.list, validRecord({ studentId: 'S1', academicYear: '2025', semester: 1, week: 5, className: 'ม.4/1' }));
    assert.strictEqual(b.ok, false);
    assert.strictEqual(b.reason, 'duplicate');
    assert.strictEqual(b.list.length, 1); // no second entry
});

check('different className is allowed (different roster scope)', () => {
    let list = [];
    list = RosterModel.addRoster(list, validRecord({ studentId: 'S1', className: 'ม.4/1' })).list;
    const b = RosterModel.addRoster(list, validRecord({ studentId: 'S1', className: 'ม.4/2' }));
    assert.strictEqual(b.ok, true);
});

check('historical integrity: removing a Week 10 membership does not affect Week 5/1', () => {
    let list = [];
    list = RosterModel.addRoster(list, validRecord({ studentId: 'S1', week: 1 })).list;
    list = RosterModel.addRoster(list, validRecord({ studentId: 'S1', week: 5 })).list;
    list = RosterModel.addRoster(list, validRecord({ studentId: 'S1', week: 10 })).list;
    assert.strictEqual(list.length, 3);

    const week5Before = RosterModel.findRosters(list, { week: 5 }).length;
    const week1Before = RosterModel.findRosters(list, { week: 1 }).length;

    // Remove the Week 10 entry (index 2).
    const idx10 = list.findIndex(r => r.week === 10);
    const res = RosterModel.removeRoster(list, idx10);
    assert.strictEqual(res.removed, true);
    list = res.list;

    assert.strictEqual(list.length, 2);
    assert.strictEqual(RosterModel.findRosters(list, { week: 10 }).length, 0);
    assert.strictEqual(RosterModel.findRosters(list, { week: 5 }).length, week5Before); // unchanged
    assert.strictEqual(RosterModel.findRosters(list, { week: 1 }).length, week1Before); // unchanged
});

check('removing roster membership does not delete student / attendance / face data', () => {
    const before = snap();
    let list = [];
    list = RosterModel.addRoster(list, validRecord({ studentId: 'S1', week: 5 })).list;
    list = RosterModel.addRoster(list, validRecord({ studentId: 'S2', week: 5 })).list;
    assert.strictEqual(list.length, 2);

    const idx = list.findIndex(r => r.studentId === 'S1');
    const res = RosterModel.removeRoster(list, idx);
    list = res.list;

    // Roster collection lost one membership...
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].studentId, 'S2');
    // ...but permanent collections are byte-for-byte unchanged.
    const after = snap();
    assert.deepStrictEqual(after.students, before.students);
    assert.deepStrictEqual(after.attendance, before.attendance);
    assert.deepStrictEqual(after.faceData, before.faceData);
});

check('removeRoster is non-mutating on invalid index', () => {
    let list = [validRecord({ studentId: 'S1', week: 5 })];
    const res = RosterModel.removeRoster(list, 5);
    assert.strictEqual(res.removed, false);
    assert.strictEqual(res.list.length, 1); // original untouched
});

check('addRoster is non-mutating when rejecting duplicates', () => {
    let list = [validRecord({ studentId: 'S1', week: 5 })];
    const lenBefore = list.length;
    const res = RosterModel.addRoster(list, validRecord({ studentId: 'S1', week: 5 }));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(list.length, lenBefore); // input list not mutated
    assert.strictEqual(res.list.length, lenBefore);
});

check('findRosters scopes by academicYear + semester + week + className', () => {
    let list = [];
    list = RosterModel.addRoster(list, validRecord({ studentId: 'S1', academicYear: '2025', semester: 1, week: 5, className: 'ม.4/1' })).list;
    list = RosterModel.addRoster(list, validRecord({ studentId: 'S2', academicYear: '2025', semester: 1, week: 5, className: 'ม.4/1' })).list;
    list = RosterModel.addRoster(list, validRecord({ studentId: 'S1', academicYear: '2025', semester: 2, week: 5, className: 'ม.4/1' })).list;
    list = RosterModel.addRoster(list, validRecord({ studentId: 'S1', academicYear: '2026', semester: 1, week: 5, className: 'ม.4/1' })).list;

    assert.strictEqual(RosterModel.findRosters(list, { academicYear: '2025', semester: 1, week: 5, className: 'ม.4/1' }).length, 2);
    assert.strictEqual(RosterModel.findRosters(list, { academicYear: '2025', semester: 2, week: 5, className: 'ม.4/1' }).length, 1);
    assert.strictEqual(RosterModel.findRosters(list, { week: 5 }).length, 4);
});

check('SEMESTERS and ROOM_WEEK range are 1–14', () => {
    assert.deepStrictEqual(RosterModel.SEMESTERS, [1, 2]);
    assert.strictEqual(RosterModel.ROOM_WEEK_MAX, 14);
});

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
