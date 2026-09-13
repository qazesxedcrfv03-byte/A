// roster.js — Historical roster membership data model (pure logic, Node + browser).
//
// Concept (STEP 8): Student is permanent (registeredFaces). Roster membership is
// historical and scoped to (Academic Year, Semester, Week, Class). Adding/removing
// a student from a week only mutates roster memberships — it NEVER creates, deletes,
// or touches students, attendance, or face data.
//
// This module is storage-agnostic: all functions operate on an in-memory list and
// return results. app.js DataStore methods persist via localStorage. Mirrors the
// evidence.js pattern so it is directly unit-testable in Node (module.exports guard).
(function () {
    'use strict';
    var NS = (typeof window !== 'undefined') ? window : (typeof global !== 'undefined' ? global : {});

    var SEMESTERS = [1, 2];            // ภาคการศึกษา 1 / 2
    var ROOM_WEEK_MIN = 1;
    var ROOM_WEEK_MAX = 14;            // Weeks 1–14

    function isValidYear(y) {
        return /^\d{4}$/.test(String(y));
    }

    // ── Validation ──
    function validateRoster(record) {
        if (!record || typeof record !== 'object') return false;
        if (!record.rosterId || typeof record.rosterId !== 'string' || !record.rosterId.trim()) return false;
        if (!record.studentId || typeof record.studentId !== 'string' || !record.studentId.trim()) return false;
        if (!record.academicYear || !isValidYear(record.academicYear)) return false;
        if (record.semester !== 1 && record.semester !== 2) return false;
        if (typeof record.week !== 'number' || record.week < ROOM_WEEK_MIN || record.week > ROOM_WEEK_MAX) return false;
        if (!record.className || typeof record.className !== 'string' || !record.className.trim()) return false;
        if (typeof record.addedAt !== 'number' || isNaN(record.addedAt)) return false;
        return true;
    }

    // Composite key enforcing: one student cannot be added twice to the same
    // (academicYear, semester, week, className). This is the @@unique constraint.
    function rosterKey(r) {
        return [r.studentId, r.academicYear, r.semester, r.week, r.className].join('|');
    }

    function findDuplicateIndex(list, record) {
        var key = rosterKey(record);
        for (var i = 0; i < list.length; i++) {
            if (rosterKey(list[i]) === key) return i;
        }
        return -1;
    }

    // Pure add: never mutates the input list. Returns { ok, list, reason }.
    // reason: 'added' | 'duplicate' | 'invalid'
    function addRoster(list, candidate) {
        if (!Array.isArray(list)) list = [];
        if (!validateRoster(candidate)) return { ok: false, list: list.slice(), reason: 'invalid' };
        if (findDuplicateIndex(list, candidate) !== -1) {
            return { ok: false, list: list.slice(), reason: 'duplicate' };
        }
        var next = list.slice();
        next.push(candidate);
        return { ok: true, list: next, reason: 'added' };
    }

    // Pure remove by index: returns { list, removed }. Removes ONLY the roster
    // membership — the student/attendance/face data are untouched by this function.
    function removeRoster(list, index) {
        if (!Array.isArray(list)) list = [];
        if (index < 0 || index >= list.length) return { list: list.slice(), removed: false };
        var next = list.slice();
        next.splice(index, 1);
        return { list: next, removed: true };
    }

    // Pure query by any subset of { studentId, academicYear, semester, week, className }.
    function findRosters(list, query) {
        if (!Array.isArray(list)) list = [];
        if (!query) query = {};
        return list.filter(function (r) {
            if (query.studentId && r.studentId !== query.studentId) return false;
            if (query.academicYear != null && r.academicYear !== query.academicYear) return false;
            if (query.semester != null && r.semester !== query.semester) return false;
            if (query.week != null && r.week !== query.week) return false;
            if (query.className != null && r.className !== query.className) return false;
            return true;
        });
    }

    var RosterModel = {
        SEMESTERS: SEMESTERS,
        ROOM_WEEK_MIN: ROOM_WEEK_MIN,
        ROOM_WEEK_MAX: ROOM_WEEK_MAX,
        validateRoster: validateRoster,
        rosterKey: rosterKey,
        addRoster: addRoster,
        removeRoster: removeRoster,
        findRosters: findRosters,
    };

    NS.RosterModel = RosterModel;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = RosterModel;
    }
})();
