// class-model.js — Class data model (pure logic, Node + browser).
//
// Database foundation for multi-class support (STEP 4).
//
// Concept: A Class is a first-class entity identified by its code (e.g. "ม.4/1"),
// which matches the existing `student.year` field. This model provides validation,
// persistence, and a SAFE MIGRATION that derives class records from existing student
// data — it never creates, deletes, or modifies students, attendance, leave, or face
// data. Adding/removing a class only mutates the classes collection.
//
// This module is storage-agnostic: all functions operate on an in-memory list and
// return results. app.js DataStore methods persist via localStorage. Mirrors the
// roster.js pattern so it is directly unit-testable in Node (module.exports guard).
(function () {
    'use strict';
    var NS = (typeof window !== 'undefined') ? window : (typeof global !== 'undefined' ? global : {});

    function isValidYear(y) {
        return /^\d{4}$/.test(String(y));
    }

    // ── Validation ──
    function validateClass(record) {
        if (!record || typeof record !== 'object') return false;
        if (!record.classId || typeof record.classId !== 'string' || !record.classId.trim()) return false;
        if (!record.code || typeof record.code !== 'string' || !record.code.trim()) return false;
        if (!record.name || typeof record.name !== 'string' || !record.name.trim()) return false;
        if (typeof record.createdAt !== 'number' || isNaN(record.createdAt)) return false;
        return true;
    }

    // Composite key: classId and code must both be unique.
    function classKey(r) {
        return String(r.classId) + '|' + String(r.code);
    }

    function findDuplicateIndex(list, record) {
        var key = classKey(record);
        for (var i = 0; i < list.length; i++) {
            if (classKey(list[i]) === key) return i;
        }
        return -1;
    }

    function findDuplicateByCode(list, code) {
        var codeStr = String(code || '').trim();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].code).trim() === codeStr) return i;
        }
        return -1;
    }

    // Pure add: never mutates the input list. Returns { ok, list, reason }.
    // reason: 'added' | 'duplicate' | 'invalid'
    // A duplicate is triggered by either matching classId OR matching code.
    function addClass(list, candidate) {
        if (!Array.isArray(list)) list = [];
        if (!validateClass(candidate)) return { ok: false, list: list.slice(), reason: 'invalid' };
        if (findDuplicateIndex(list, candidate) !== -1) {
            return { ok: false, list: list.slice(), reason: 'duplicate' };
        }
        if (findDuplicateByCode(list, candidate.code) !== -1) {
            return { ok: false, list: list.slice(), reason: 'duplicate' };
        }
        var next = list.slice();
        next.push(candidate);
        return { ok: true, list: next, reason: 'added' };
    }

    // Pure remove by index: returns { list, removed }. Removes ONLY the class
    // definition — students, attendance, face data, and rosters are untouched.
    function removeClass(list, index) {
        if (!Array.isArray(list)) list = [];
        if (index < 0 || index >= list.length) return { list: list.slice(), removed: false };
        var next = list.slice();
        next.splice(index, 1);
        return { list: next, removed: true };
    }

    // Pure query by any subset of { classId, code }.
    function findClasses(list, query) {
        if (!Array.isArray(list)) list = [];
        if (!query) query = {};
        return list.filter(function (r) {
            if (query.classId && r.classId !== query.classId) return false;
            if (query.code != null && r.code !== query.code) return false;
            return true;
        });
    }

    // Safe migration: derive class records from existing student.year values.
    // This does NOT modify students, attendance, or any existing data — it only
    // reads student.year and produces a deduplicated class list. Used to bootstrap
    // the fg_classes collection from the current database.
    function deriveClasses(students) {
        if (!Array.isArray(students)) return [];
        var seen = {};
        var now = Date.now();
        var result = [];
        students.forEach(function (s) {
            var code = (s && s.year) ? String(s.year).trim() : '';
            if (!code || seen[code]) return;
            seen[code] = true;
            result.push({
                classId: generateClassId(),
                code: code,
                name: code,
                createdAt: now,
            });
        });
        return result;
    }

    function generateClassId() {
        return 'cls_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    }

    // Re-derive the classes collection from current students, preserving any
    // manually-added classes that still have students. Returns { list, added, removed }.
    function reconcileClasses(classes, students) {
        var derived = deriveClasses(students);
        var derivedCodes = {};
        derived.forEach(function (c) { derivedCodes[c.code] = c; });

        // Keep existing classes that still have students, add new ones from students.
        var existingCodes = {};
        var merged = [];
        var addedCount = 0;
        (classes || []).forEach(function (c) {
            if (derivedCodes[c.code]) {
                merged.push(c); // keep existing class record
                existingCodes[c.code] = true;
            }
        });
        derived.forEach(function (c) {
            if (!existingCodes[c.code]) {
                merged.push(c);
                addedCount++;
            }
        });

        // Detect removed: classes in the old list that have no matching student.
        var removed = (classes || []).filter(function (c) {
            return !derivedCodes[c.code];
        });

        return { list: merged, added: addedCount, removed: removed };
    }

    // Count how many students belong to a given class code.
    function studentCountForClass(students, code) {
        if (!Array.isArray(students)) return 0;
        return students.filter(function (s) { return (s && s.year) ? String(s.year).trim() === code : false; }).length;
    }

    var ClassModel = {
        validateClass: validateClass,
        classKey: classKey,
        findDuplicateIndex: findDuplicateIndex,
        findDuplicateByCode: findDuplicateByCode,
        addClass: addClass,
        removeClass: removeClass,
        findClasses: findClasses,
        deriveClasses: deriveClasses,
        reconcileClasses: reconcileClasses,
        studentCountForClass: studentCountForClass,
        generateClassId: generateClassId,
    };

    NS.ClassModel = ClassModel;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ClassModel;
    }
})();
