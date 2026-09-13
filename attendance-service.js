'use strict';
/*
 * server/attendance-service.js
 * STEP 9 — Protected Admin historical attendance management.
 *
 * A minimal, dependency-free HTTP service (Node built-ins) that is the single,
 * server-side authoritative store for historical attendance corrections.
 *
 *   POST /api/attendance/correction  — validated admin correction (update/create/remove)
 *   GET  /api/attendance?date=..    — filtered attendance list
 *   GET  /api/audit?limit=..       — audit trail of corrections
 *   GET  /health
 *   OPTIONS *                      — CORS preflight
 *
 * Why a server DB at all (STEP 9 requirements):
 *   - "Do NOT directly mutate the database from the frontend. Use protected API."
 *     The browser never writes this store directly; it POSTs corrections here and the
 *     server validates + persists + (re)syncs the client cache from its own response.
 *   - Server-side validation is the gate (date shape, status enum, reason required,
 *     method allowlist). The frontend cannot bypass it.
 *   - "If attendance already exists: do not blindly create another record." -> the
 *     correction handler updates an existing (studentId, date) record / removes it
 *     rather than inserting a duplicate (correction/update flow).
 *   - "Changing Week N must not silently modify other weeks" -> every operation is
 *     scoped by the (studentId, date) primary key; other records are never touched.
 *
 * Persistence: JSON file "database" (attendance.json, leaves.json) under DATA_DIR,
 * held in memory and flushed on write. This is the real, durable store the tests
 * exercise (not a mock).
 */
const http = require('http');
const crypto = require('crypto');
const { loadTable, saveTable } = require('./supabase-store');

// Table names in Supabase (see supabase-schema.sql).
const TBL = {
    STUDENTS: 'students',
    ATTENDANCE: 'attendance',
    LEAVES: 'leaves',
    CLASSES: 'classes',
    CLASS_STUDENTS: 'class_students',
    SCAN_LOG: 'scan_log',
    AUDIT: 'audit',
};

const STATUS = new Set(['present', 'late', 'absent', 'leave', 'holiday']);
// Reuse the existing app method conventions: face scan strings + STEP 9 enums.
const METHOD_RE = /^(FACE_RECOGNITION|MANUAL_ADMIN)|^(ใบหน้า|แก้ไข)/;

const CONFIG = {
    PORT: Number(process.env.ATTENDANCE_PORT || 3031),
    ADMIN_TOKEN: process.env.ATTENDANCE_ADMIN_TOKEN || 'dev-evidence-token-change-me',
    ALLOWED_ORIGINS: (process.env.ATTENDANCE_ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean),
    DATA_DIR: process.env.ATTENDANCE_DATA_DIR || '',
};
if (!process.env.ATTENDANCE_ADMIN_TOKEN) {
    console.warn('[SECURITY] ATTENDANCE_ADMIN_TOKEN unset — using insecure dev default. Set it in production.');
}

function securityHeaders(req) {
    const h = {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'camera=self, microphone=(), geolocation=(), payment=()',
    };
    if ((req && (req.headers['x-forwarded-proto'] === 'https' || req.socket && req.socket.encrypted)) || process.env.HTTPS_ENABLED === 'true') {
        h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    }
    return h;
}

function generateId() { return 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }

// ── Auth / CORS / helpers (mirror storage-service.js) ──
function isAuthorized(req) {
    const h = req.headers['authorization'] || '';
    if (!h.startsWith('Bearer ')) return false;
    const a = Buffer.from(h.slice('Bearer '.length).trim(), 'utf8');
    const b = Buffer.from(CONFIG.ADMIN_TOKEN, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}
function corsHeaders(req) {
    const origin = req.headers.origin;
    if (CONFIG.ALLOWED_ORIGINS.indexOf('*') !== -1) {
        return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Max-Age': '86400' };
    }
    if (origin && CONFIG.ALLOWED_ORIGINS.indexOf(origin) !== -1) {
        return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
    }
    return null;
}
function jsonRes(res, req, code, obj, extra = {}) {
    const cors = corsHeaders(req);
    const sec = securityHeaders(req);
    if (!cors) {
        const b = JSON.stringify({ error: 'origin not allowed' });
        res.writeHead(403, { ...sec, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
        return res.end(b);
    }
    const b = JSON.stringify(obj);
    res.writeHead(code, { ...sec, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), 'Cache-Control': 'no-store', ...cors, ...extra });
    res.end(b);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('error', reject);
        req.on('end', () => {
            try { resolve(Buffer.concat(chunks).toString('utf8')); } catch (e) { reject(e); }
        });
    });
}
function parsePositiveInt(v, fallback) {
    const n = parseInt(v, 10);
    return (Number.isFinite(n) && n > 0 && n <= 1000) ? n : fallback;
}

// In-memory cache (the authoritative DB), loaded once + flushed on write.
let ATT = [];
let LEAVES = [];
let AUDIT = [];
// ── Classes (STEP 5) ──
let STUDENTS = [];         // registered students: [{ id, name, year, descriptors, createdAt, updatedAt }]
let CLASSES = [];          // class definitions: [{ classId, code, name, createdAt, createdBy, updatedAt }]
let CLASS_STUDENTS = [];   // student-class assignments: [{ classId, studentId, studentName, assignedAt, assignedBy }]
let SCAN_LOGS = [];        // scan history: [{ scanId, studentId, studentName, class:year, scanTime, result, attendanceStatus, evidenceRef, confidence }]

// ── Validation ──
function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function validStudentId(s) { return typeof s === 'string' && s.trim().length > 0; }
function validMethod(m) { return typeof m === 'string' && METHOD_RE.test(m); }

// ── Correction/upsert business rules (server-side; client cannot bypass) ──
function computePreviousStatus(studentId, date) {
    const att = ATT.find(r => r.studentId === studentId && r.date === date);
    if (att) return { status: (att.time && att.time > '08:00') ? 'late' : 'present', record: att };
    const lv = LEAVES.find(r => r.studentId === studentId && r.date === date && r.status === 'approved');
    if (lv) return { status: lv.type === 'holiday' ? 'holiday' : 'leave', record: lv };
    return { status: 'absent', record: null };
}

async function runCorrection(payload) {
    const studentId = String(payload.studentId || '');
    const date = payload.date;
    const newStatus = payload.newStatus;
    const reason = (typeof payload.reason === 'string') ? payload.reason.trim() : '';
    const method = payload.method;
    // Scope fields retained on records so server-side statistics can aggregate by
    // academic year / semester / week / class WITHOUT sending raw records to the browser.
    const scope = {
        academicYear: payload.academicYear || DateHelperAcademicYear(date),
        semester: Number(payload.semester) || DateHelperSemester(date),
        week: Number(payload.week) || DateHelperWeek(date),
        className: payload.className || '',
    };

    const prev = computePreviousStatus(studentId, date);
    const serverPreviousStatus = prev.status;

    // STEP 9: optimistic concurrency — reject if the client-reported previousStatus
    // does not match the server's view of the current status. This prevents stale
    // corrections from silently overwriting a record that was edited by another admin.
    if (payload.previousStatus && payload.previousStatus !== serverPreviousStatus) {
        return { ok: false, conflict: true, action: 'conflict',
            error: 'previousStatus does not match current record',
            previousStatus: serverPreviousStatus,
            newStatus: payload.newStatus };
    }

    const previousStatus = serverPreviousStatus;

    const now = Date.now();
    const ts = new Date().toISOString();

    let action, attendance = null, leave = null;

    if (newStatus === 'present' || newStatus === 'late') {
        const timeStr = newStatus === 'late' ? '08:01' : '08:00';
        const m = (method && validMethod(method)) ? method : 'MANUAL_ADMIN';
        const existing = ATT.find(r => r.studentId === studentId && r.date === date);
        if (existing) {
            existing.time = timeStr;
            existing.method = m;
            existing.updatedAt = ts;
            existing.academicYear = scope.academicYear; existing.semester = scope.semester; existing.week = scope.week; existing.className = scope.className;
            action = 'updated';
            attendance = existing;
        } else {
            const rec = {
                id: generateId(), studentId, date, time: timeStr,
                weekNum: scope.week,
                academicYear: scope.academicYear, semester: scope.semester, week: scope.week, className: scope.className,
                method: m, timestamp: now, addedBy: payload.admin || 'admin',
            };
            ATT.push(rec);
            action = 'created';
            attendance = rec;
        }
    } else if (newStatus === 'absent') {
        const idx = ATT.findIndex(r => r.studentId === studentId && r.date === date);
        if (idx !== -1) { attendance = ATT[idx]; ATT.splice(idx, 1); }
        action = attendance ? 'removed' : 'none';
        // cancel any approved leave for that day (do NOT delete the leave record)
        const lidx = LEAVES.findIndex(l => l.studentId === studentId && l.date === date && l.status === 'approved');
        if (lidx !== -1) {
            LEAVES[lidx].status = 'cancelled';
            LEAVES[lidx].reason = (LEAVES[lidx].reason || '') + ' | ยกเลิกเนื่องจาก: ' + reason;
            leave = LEAVES[lidx];
        }
    } else if (newStatus === 'leave' || newStatus === 'holiday') {
        const idx = ATT.findIndex(r => r.studentId === studentId && r.date === date);
        if (idx !== -1) { ATT.splice(idx, 1); }
        // Same record covers both: only `type` differs. Always set `type` explicitly
        // from newStatus (not left over from a prior state) — otherwise switching an
        // existing holiday record to a plain leave (or back) would silently keep the
        // stale type and computePreviousStatus would keep reporting the old one.
        const recType = newStatus === 'holiday' ? 'holiday' : 'อื่นๆ';
        const existingLeave = LEAVES.find(l => l.studentId === studentId && l.date === date && l.status === 'approved');
        if (existingLeave) {
            existingLeave.reason = reason;
            existingLeave.type = recType;
            existingLeave.academicYear = scope.academicYear; existingLeave.semester = scope.semester; existingLeave.week = scope.week; existingLeave.className = scope.className;
            leave = existingLeave;
        } else {
            const lv = { id: generateId(), studentId, date, type: recType, reason, status: 'approved', timestamp: now, addedBy: payload.admin || 'admin', academicYear: scope.academicYear, semester: scope.semester, week: scope.week, className: scope.className };
            LEAVES.push(lv);
            leave = lv;
        }
        action = newStatus;
    }

    // Authoritative persistence (the real DB write, now in Supabase).
    await saveTable(TBL.ATTENDANCE, ATT);
    await saveTable(TBL.LEAVES, LEAVES);

    // Audit trail (server-authoritative, durable).
    // STEP 10: records admin/user, student, attendance record date+id, previous/new
    // status, reason, and timestamp. Does NOT store biometric data or secrets.
    const recordId = (attendance && attendance.id) || (leave && leave.id) || null;
    const audit = {
        action: 'attendance_correction',
        recordId: recordId,
        studentId, date,
        previousStatus, newStatus,
        reason, method: method || null,
        changedBy: payload.admin || 'admin',
        timestamp: ts,
        // Academic scope for traceability across weeks/classes (aggregated, not raw data).
        academicYear: scope.academicYear, semester: scope.semester,
        week: scope.week, className: scope.className,
    };
    AUDIT.push(audit);
    // audit is best-effort persisted; never blocks the correction.
    try { await saveTable(TBL.AUDIT, AUDIT); } catch (e) { /* ignore audit persistence errors */ }

    return { ok: true, action, previousStatus, newStatus, method: method || null, recordId: (attendance && attendance.id) || (leave && leave.id) || null, attendance, leave };
}

// week-of-academic-year by date (mirrors DateHelper.getAcademicWeekNum, ISO weeks from May 1)
const MAY1_BASELINE = (dateStr) => {
    const d = new Date(dateStr + 'T00:00:00');
    const start = new Date(d.getFullYear(), 4, 1);
    const diff = d - start;
    return Math.max(1, Math.min(18, Math.ceil(diff / (7 * 24 * 60 * 60 * 1000))));
};
function DateHelperWeek(date) { return MAY1_BASELINE(date); }
// Mirrors app.js DateHelper (Thai academic calendar, May-based).
function DateHelperAcademicYear(dateStr) {
    const d = new Date((dateStr || '') + 'T00:00:00');
    if (isNaN(d)) return new Date().getFullYear().toString();
    const y = d.getFullYear();
    return (d.getMonth() >= 4 ? y : y - 1).toString();
}
function DateHelperSemester(dateStr) {
    const d = new Date((dateStr || '') + 'T00:00:00');
    if (isNaN(d)) { const m = new Date().getMonth(); return (m >= 4 && m <= 9) ? 1 : 2; }
    const m = d.getMonth();
    return (m >= 4 && m <= 9) ? 1 : 2;
}
function isLateTime(timeStr) { if (!timeStr) return false; const p = String(timeStr).split(':'); if (p.length < 2) return false; const h = parseInt(p[0], 10), mi = parseInt(p[1], 10); return h > 8 || (h === 8 && mi > 0); }
function dateToStr(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ── Handlers ──
function handleOptions(req, res) {
    const cors = corsHeaders(req);
    if (!cors) return jsonRes(res, req, 403, { error: 'origin not allowed' });
    res.writeHead(204, { ...securityHeaders(req), ...cors }); res.end();
}
function handleHealth(req, res) {
    // STEP 8: return real counts for every data store — no records, no secrets, no tokens.
    jsonRes(res, req, 200, {
        ok: true,
        service: 'attendance-service',
        version: '1.0.0',
        timestamp: Date.now(),
        dataDir: CONFIG.DATA_DIR,
        counts: {
            attendance: ATT.length,
            leaves: LEAVES.length,
            classes: CLASSES.length,
            classStudents: CLASS_STUDENTS.length,
            scanLogs: SCAN_LOGS.length,
            audit: AUDIT.length,
        },
        persistence: 'supabase',
    });
}

function handleList(req, res) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    const u = new URL(req.url, 'http://x');
    const date = (u.searchParams.get('date') || '').trim();
    const studentId = (u.searchParams.get('studentId') || '').trim();
    const week = parseInt(u.searchParams.get('week'), 10);
    const className = (u.searchParams.get('className') || '').trim();
    const academicYear = (u.searchParams.get('academicYear') || '').trim();
    const semester = parseInt(u.searchParams.get('semester'), 10);
    if (date && !validDate(date)) return jsonRes(res, req, 400, { error: 'invalid date' });
    if (studentId && !validStudentId(studentId)) return jsonRes(res, req, 400, { error: 'invalid studentId' });
    if (week && (!Number.isFinite(week) || week < 1 || week > 14)) return jsonRes(res, req, 400, { error: 'invalid week (1-14)' });
    let out = ATT;
    if (date) out = out.filter(r => r.date === date);
    if (studentId) out = out.filter(r => r.studentId === studentId);
    if (week) out = out.filter(r => r.week === week || r.weekNum === week);
    if (className) out = out.filter(r => r.className === className);
    if (academicYear) out = out.filter(r => r.academicYear === academicYear);
    if (semester && !isNaN(semester)) out = out.filter(r => r.semester === semester);
    const limit = parsePositiveInt(u.searchParams.get('limit'), 200);
    jsonRes(res, req, 200, { attendance: out.slice(0, limit), total: out.length });
}

function handleCorrection(req, res) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    return readBody(req).then(async raw => {
        let body;
        try { body = JSON.parse(raw || '{}'); } catch (e) { return jsonRes(res, req, 400, { error: 'invalid JSON' }); }
        const studentId = body.studentId;
        const date = body.date;
        const previousStatus = body.previousStatus;
        const newStatus = body.newStatus;
        const reason = body.reason;
        const method = body.method;
        if (!validStudentId(studentId)) return jsonRes(res, req, 400, { error: 'invalid studentId' });
        if (!validDate(date)) return jsonRes(res, req, 400, { error: 'invalid date' });
        if (!previousStatus || !STATUS.has(previousStatus)) return jsonRes(res, req, 400, { error: 'invalid or missing previousStatus (must be one of: present, late, absent, leave, holiday)' });
        if (!STATUS.has(newStatus)) return jsonRes(res, req, 400, { error: 'invalid newStatus' });
        if (!(reason && String(reason).trim())) return jsonRes(res, req, 400, { error: 'reason required' });
        if (method != null && !validMethod(method)) return jsonRes(res, req, 400, { error: 'invalid method' });
        const result = await runCorrection({ studentId, date, previousStatus, newStatus, reason: String(reason), method, admin: body.admin,
            academicYear: body.academicYear, semester: body.semester, week: body.week, className: body.className });
        if (!result.ok) {
            // 409 Conflict: the client's previousStatus does not match the server's view
            // (the record changed since the client last read it).
            return jsonRes(res, req, 409, result);
        }
        jsonRes(res, req, 200, result);
    }).catch(e => {
        console.error('[db] correction error:', e);
        jsonRes(res, req, 500, { error: 'internal error' });
    });
}

function handleAudit(req, res) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    const u = new URL(req.url, 'http://x');
    const limit = parsePositiveInt(u.searchParams.get('limit'), 100);
    const qStudent = (u.searchParams.get('studentId') || '').trim();
    const qDate = (u.searchParams.get('date') || '').trim();
    const qAdmin = (u.searchParams.get('admin') || '').trim();
    const qAction = (u.searchParams.get('action') || '').trim();
    let rows = AUDIT;
    if (qStudent) rows = rows.filter(a => a.studentId === qStudent);
    if (qDate) rows = rows.filter(a => a.date === qDate);
    if (qAdmin) rows = rows.filter(a => (a.changedBy || '') === qAdmin);
    if (qAction) rows = rows.filter(a => a.action === qAction);
    jsonRes(res, req, 200, { audit: rows.slice(-limit).reverse() });
}

// Server-side aggregation for historical statistics. Returns only aggregated
// numbers + small trend/distribution arrays — never the raw attendance DB.
function handleStats(req, res) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    const u = new URL(req.url, 'http://x');
    const q = (k) => u.searchParams.get(k) || '';
    const date = q('date');
    const start = q('start');
    const end = q('end');
    const days = parsePositiveInt(u.searchParams.get('days'), 0) || 0;
    const academicYear = q('academicYear');
    const semester = q('semester');
    const week = q('week');
    const className = q('className');
    const studentId = q('studentId');
    if (date && !validDate(date)) return jsonRes(res, req, 400, { error: 'invalid date' });
    if (start && !validDate(start)) return jsonRes(res, req, 400, { error: 'invalid start' });
    if (end && !validDate(end)) return jsonRes(res, req, 400, { error: 'invalid end' });

    // Determine the date range to aggregate over (server-side, real DB).
    let startDate = null, endDate = null, singleDate = null;
    if (date) { singleDate = date; startDate = date; endDate = date; }
    else if (start && end) { startDate = start; endDate = end; }
    else if (days > 0) {
        const dEnd = new Date();
        const d = new Date(dEnd);
        d.setDate(d.getDate() - (days - 1));
        startDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        endDate = dEnd.getFullYear() + '-' + String(dEnd.getMonth() + 1).padStart(2, '0') + '-' + String(dEnd.getDate()).padStart(2, '0');
    }

    const inRange = (r) => {
        if (startDate && r.date < startDate) return false;
        if (endDate && r.date > endDate) return false;
        return true;
    };
    const att = ATT.filter(r => inRange(r)
        && (!academicYear || r.academicYear === academicYear)
        && (semester ? Number(r.semester) === Number(semester) : true)
        && (week ? Number(r.week) === Number(week) : true)
        && (!className || r.className === className)
        && (!studentId || r.studentId === studentId));
    const lev = LEAVES.filter(r => r.status === 'approved' && r.type !== 'holiday' && inRange(r)
        && (!academicYear || r.academicYear === academicYear)
        && (semester ? Number(r.semester) === Number(semester) : true)
        && (week ? Number(r.week) === Number(week) : true)
        && (!className || r.className === className)
        && (!studentId || r.studentId === studentId));

    const present = att.filter(r => !isLateTime(r.time)).length;
    const late = att.filter(r => isLateTime(r.time)).length;
    const leave = lev.length;

    // Per-date trend (attendance trend / late trend source).
    const dateSet = [];
    if (singleDate) {
        dateSet.push(singleDate);
    } else if (startDate && endDate) {
        const cur = new Date(startDate + 'T00:00:00');
        const end = new Date(endDate + 'T00:00:00');
        for (let d = new Date(cur); d <= end; d.setDate(d.getDate() + 1)) {
            dateSet.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
        }
    } else {
        // No fixed range: enumerate every date present in ATT+LEAVES.
        const s = new Set(att.map(r => r.date).concat(lev.map(r => r.date)));
        dateSet.push(...[...s].sort());
    }
    const byDate = dateSet.map(d => {
        const a = ATT.filter(r => r.date === d && (!studentId || r.studentId === studentId) && (!className || r.className === className));
        const p = a.filter(r => !isLateTime(r.time)).length;
        const l = a.filter(r => isLateTime(r.time)).length;
        const lv = LEAVES.filter(r => r.date === d && r.status === 'approved' && r.type !== 'holiday' && (!studentId || r.studentId === studentId) && (!className || r.className === className)).length;
        return { date: d, present: p, late: l, leave: lv };
    });

    // Per-class distribution (class comparison).
    const classMap = new Map();
    att.forEach(r => {
        const c = r.className || '(ไม่มีชั้น)';
        if (!classMap.has(c)) classMap.set(c, { present: 0, late: 0, leave: 0 });
        if (isLateTime(r.time)) classMap.get(c).late++; else classMap.get(c).present++;
    });
    lev.forEach(r => {
        const c = r.className || '(ไม่มีชั้น)';
        if (!classMap.has(c)) classMap.set(c, { present: 0, late: 0, leave: 0 });
        classMap.get(c).leave++;
    });
    const byClass = {};
    [...classMap.entries()].forEach(([k, v]) => { byClass[k] = v; });

    // Per-student distribution (for the Student filter drill-down).
    const studentMap = new Map();
    att.forEach(r => {
        if (!studentMap.has(r.studentId)) studentMap.set(r.studentId, { present: 0, late: 0, leave: 0 });
        if (isLateTime(r.time)) studentMap.get(r.studentId).late++; else studentMap.get(r.studentId).present++;
    });
    lev.forEach(r => {
        if (!studentMap.has(r.studentId)) studentMap.set(r.studentId, { present: 0, late: 0, leave: 0 });
        studentMap.get(r.studentId).leave++;
    });

    jsonRes(res, req, 200, {
        scope: { date: singleDate, start: startDate, end: endDate, days, academicYear, semester, week, className, studentId },
        counts: { present, late, leave, totalAttended: present + late },
        byStatus: { present, late, leave },
        byDate,          // attendance trend source (present/late/leave per date)
        byClass,         // class comparison
        byStudent: Object.fromEntries(studentMap),
    });
}

// ══════════════════════════════════════════════
// Classes (STEP 5)
// ══════════════════════════════════════════════
// Server-side authoritative store for class definitions and student-class
// assignments. Persists to classes.json + class_students.json. Follows the same
// auth/CORS/validation patterns as the existing attendance/audit/stats handlers.
function validClassId(s) { return typeof s === 'string' && s.trim().length > 0; }
function validClassCode(s) { return typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 64; }
function validClassName(s) { return typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 128; }

// Parse the URL path into segments: /api/classes/:cid/students/:sid -> ['api','classes',cid,'students',sid]
function pathSegments(req) {
    const url = new URL(req.url, 'http://x');
    return url.pathname.split('/').filter(Boolean);
}
// Parse the body of a POST/PUT request as JSON. Resolves to an object or null on error.
function readBodyJson(req) {
    return readBody(req).then(raw => {
        try { return JSON.parse(raw || '{}'); } catch (e) { return null; }
    });
}

function classById(id) { return CLASSES.find(c => c.classId === id) || null; }
function generateClassId() { return 'cls_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }
function assignmentIndex(classId, studentId) { return CLASS_STUDENTS.findIndex(a => a.classId === classId && a.studentId === studentId); }

// ── Students (registered faces) — server-side persistence so registrations
//    survive a browser reset and are visible from any device ──
function validStudentRecord(s) {
    if (!s || typeof s !== 'object') return false;
    if (typeof s.id !== 'string' || !s.id.trim()) return false;
    if (typeof s.name !== 'string' || !s.name.trim()) return false;
    if (!Array.isArray(s.descriptors) || s.descriptors.length === 0) return false;
    for (const d of s.descriptors) { if (!Array.isArray(d) || d.length !== 128) return false; }
    return true;
}

function handleListStudents(req, res) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    jsonRes(res, req, 200, { students: STUDENTS.map(s => ({ id: s.id, name: s.name, year: s.year, descriptors: s.descriptors, createdAt: s.createdAt, updatedAt: s.updatedAt })) });
}

function handleUpsertStudent(req, res) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    return readBodyJson(req).then(async body => {
        if (!validStudentRecord(body)) return jsonRes(res, req, 400, { error: 'invalid student record (id, name, descriptors[128] required)' });
        const now = Date.now();
        const idx = STUDENTS.findIndex(s => s.id === body.id);
        if (idx !== -1) {
            STUDENTS[idx].name = body.name.trim();
            STUDENTS[idx].year = body.year || STUDENTS[idx].year || null;
            STUDENTS[idx].descriptors = body.descriptors;
            STUDENTS[idx].updatedAt = now;
        } else {
            STUDENTS.push({ id: body.id.trim(), name: body.name.trim(), year: body.year || null, descriptors: body.descriptors, createdAt: now, updatedAt: now });
        }
        try {
            await saveTable(TBL.STUDENTS, STUDENTS, 'id');
        } catch (e) {
            console.error('[students] persistence error:', e.message);
            return jsonRes(res, req, 500, { error: 'internal error' });
        }
        jsonRes(res, req, idx !== -1 ? 200 : 201, { id: body.id, synced: true });
    }).catch(e => {
        jsonRes(res, req, 400, { error: 'invalid request', detail: e.message });
    });
}

async function handleDeleteStudent(req, res, studentId) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    const idx = STUDENTS.findIndex(s => s.id === studentId);
    if (idx === -1) return jsonRes(res, req, 404, { error: 'student not found' });
    STUDENTS.splice(idx, 1);
    try {
        await saveTable(TBL.STUDENTS, STUDENTS, 'id');
    } catch (e) {
        console.error('[students] delete persistence error:', e.message);
        return jsonRes(res, req, 500, { error: 'internal error' });
    }
    jsonRes(res, req, 200, { deleted: true, id: studentId });
}

function handleListClasses(req, res) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    const q = new URL(req.url, 'http://x');
    const code = (q.searchParams.get('code') || '').trim();
    let out = CLASSES;
    if (code) out = out.filter(c => c.code === code);
    const enriched = out.map(c => {
        const count = CLASS_STUDENTS.filter(a => a.classId === c.classId).length;
        return { classId: c.classId, code: c.code, name: c.name, createdAt: c.createdAt, createdBy: c.createdBy, updatedAt: c.updatedAt, studentCount: count };
    });
    jsonRes(res, req, 200, { classes: enriched });
}

function handleCreateClass(req, res) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    return readBodyJson(req).then(async body => {
        if (!body || typeof body !== 'object') return jsonRes(res, req, 400, { error: 'invalid JSON body' });
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        const name  = typeof body.name === 'string' ? body.name.trim() : '';
        if (!validClassCode(code)) return jsonRes(res, req, 400, { error: 'invalid or missing class code (1–64 chars)' });
        if (!validClassName(name)) return jsonRes(res, req, 400, { error: 'invalid or missing class name (1–128 chars)' });
        if (CLASSES.some(c => c.code === code)) return jsonRes(res, req, 409, { error: 'class code already exists', code });
        const now = Date.now();
        const record = {
            classId: generateClassId(),
            code: code,
            name: name,
            createdAt: now,
            createdBy: body.admin || 'admin',
            updatedAt: now,
        };
        CLASSES.push(record);
        await saveTable(TBL.CLASSES, CLASSES, 'classId');
        jsonRes(res, req, 201, { classId: record.classId, code: record.code, name: record.name, createdAt: record.createdAt, studentCount: 0 });
    }).catch(e => {
        console.error('[classes] create error:', e);
        jsonRes(res, req, 500, { error: 'internal error' });
    });
}

function handleUpdateClass(req, res, classId) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    if (!validClassId(classId)) return jsonRes(res, req, 400, { error: 'invalid classId' });
    const existing = classById(classId);
    if (!existing) return jsonRes(res, req, 404, { error: 'class not found' });
    return readBodyJson(req).then(async body => {
        if (!body || typeof body !== 'object') return jsonRes(res, req, 400, { error: 'invalid JSON body' });
        if (body.name !== undefined) {
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            if (!validClassName(name)) return jsonRes(res, req, 400, { error: 'invalid class name (1–128 chars)' });
            existing.name = name;
        }
        if (body.code !== undefined) {
            const code = typeof body.code === 'string' ? body.code.trim() : '';
            if (!validClassCode(code)) return jsonRes(res, req, 400, { error: 'invalid class code (1–64 chars)' });
            if (code !== existing.code && CLASSES.some(c => c.code === code)) {
                return jsonRes(res, req, 409, { error: 'class code already exists', code });
            }
            existing.code = code;
        }
        existing.updatedAt = Date.now();
        existing.updatedBy = body.admin || 'admin';
        await saveTable(TBL.CLASSES, CLASSES, 'classId');
        const count = CLASS_STUDENTS.filter(a => a.classId === classId).length;
        jsonRes(res, req, 200, { classId: existing.classId, code: existing.code, name: existing.name, createdAt: existing.createdAt, updatedAt: existing.updatedAt, studentCount: count });
    }).catch(e => {
        console.error('[classes] update error:', e);
        jsonRes(res, req, 500, { error: 'internal error' });
    });
}

async function handleDeleteClass(req, res, classId) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    if (!validClassId(classId)) return jsonRes(res, req, 400, { error: 'invalid classId' });
    const idx = CLASSES.findIndex(c => c.classId === classId);
    if (idx === -1) return jsonRes(res, req, 404, { error: 'class not found' });
    const removed = CLASSES[idx];
    CLASSES.splice(idx, 1);
    // Cascade-delete assignments only if the body requests it (default: preserve students)
    // Students are NEVER deleted — only the class-student mapping is affected.
    CLASS_STUDENTS = CLASS_STUDENTS.filter(a => a.classId !== classId);
    try {
        await saveTable(TBL.CLASSES, CLASSES, 'classId');
        await saveTable(TBL.CLASS_STUDENTS, CLASS_STUDENTS, 'id');
    } catch (e) {
        console.error('[classes] delete persistence error:', e.message);
        return jsonRes(res, req, 500, { error: 'internal error' });
    }
    jsonRes(res, req, 200, { deleted: true, classId, code: removed.code });
}

function handleListClassStudents(req, res, classId) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    if (!validClassId(classId)) return jsonRes(res, req, 400, { error: 'invalid classId' });
    if (!classById(classId)) return jsonRes(res, req, 404, { error: 'class not found' });
    const assignments = CLASS_STUDENTS.filter(a => a.classId === classId);
    jsonRes(res, req, 200, { classId, students: assignments });
}

function handleAssignStudent(req, res, classId) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    return readBodyJson(req).then(async body => {
        if (!body || typeof body !== 'object') return jsonRes(res, req, 400, { error: 'invalid JSON body' });
        const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : '';
        const studentName = typeof body.studentName === 'string' ? body.studentName.trim() : '';
        if (!validStudentId(studentId)) return jsonRes(res, req, 400, { error: 'invalid or missing studentId' });
        if (!classById(classId)) return jsonRes(res, req, 404, { error: 'class not found' });
        const ix = assignmentIndex(classId, studentId);
        const now = Date.now();
        if (ix !== -1) {
            // Update existing assignment
            CLASS_STUDENTS[ix].studentName = studentName || CLASS_STUDENTS[ix].studentName;
            CLASS_STUDENTS[ix].assignedBy = body.admin || 'admin';
            CLASS_STUDENTS[ix].assignedAt = now;
        } else {
            CLASS_STUDENTS.push({ classId, studentId, studentName, assignedAt: now, assignedBy: body.admin || 'admin' });
        }
        await saveTable(TBL.CLASS_STUDENTS, CLASS_STUDENTS, 'id');
        jsonRes(res, req, 201, { classId, studentId, studentName, assignedAt: now });
    }).catch(e => {
        console.error('[classes] assign error:', e);
        jsonRes(res, req, 500, { error: 'internal error' });
    });
}

async function handleUnassignStudent(req, res, classId, studentId) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    if (!validClassId(classId)) return jsonRes(res, req, 400, { error: 'invalid classId' });
    if (!validStudentId(studentId)) return jsonRes(res, req, 400, { error: 'invalid studentId' });
    if (!classById(classId)) return jsonRes(res, req, 404, { error: 'class not found' });
    const ix = assignmentIndex(classId, studentId);
    if (ix === -1) return jsonRes(res, req, 404, { error: 'assignment not found' });
    CLASS_STUDENTS.splice(ix, 1);
    try {
        await saveTable(TBL.CLASS_STUDENTS, CLASS_STUDENTS, 'id');
    } catch (e) {
        console.error('[classes] unassign persistence error:', e.message);
        return jsonRes(res, req, 500, { error: 'internal error' });
    }
    // Student record itself is NEVER deleted — only the mapping.
    jsonRes(res, req, 200, { unassigned: true, classId, studentId });
}

// ── Scan History (STEP 7) ──
function validScanResult(s) {
    return ['recognized', 'unknown', 'duplicate', 'failed'].includes(String(s || '').toLowerCase());
}
function handleLogScan(req, res) {
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    readBodyJson(req).then(async function (body) {
        if (!body || typeof body !== 'object') return jsonRes(res, req, 400, { error: 'invalid JSON body' });
        var result = String(body.result || '').trim().toLowerCase();
        if (!validScanResult(result)) return jsonRes(res, req, 400, { error: 'invalid or missing result (recognized|unknown|duplicate|failed)' });
        // date computed server-side (not trusted from client)
        var now = Date.now();
        var dateStr = dateToStr(now);
        var record = {
            scanId: 'scan_' + now + '_' + Math.random().toString(36).slice(2, 10),
            studentId: body.studentId || null,
            studentName: body.studentName || null,
            class: body.class || null,
            scanTime: body.scanTime || now,
            date: dateStr,
            result: result,
            attendanceStatus: body.attendanceStatus || null,
            evidenceRef: body.evidenceRef || null,
            confidence: body.confidence || null,
            admin: body.admin || 'admin',
            error: body.error || null,
        };
        SCAN_LOGS.push(record);
        await saveTable(TBL.SCAN_LOG, SCAN_LOGS, 'scanId');
        jsonRes(res, req, 201, { scanId: record.scanId });
    }).catch(function (e) {
        console.error('[scan-log] error:', e);
        jsonRes(res, req, 500, { error: 'internal error' });
    });
}

function handleListScans(req, res) {
    // GET /api/scans?limit=N&date=YYYY-MM-DD&result=recognized&className=ม.4/1
    if (!isAuthorized(req)) return jsonRes(res, req, 401, { error: 'unauthorized' });
    var q = new URL(req.url, 'http://x');
    var limit = parsePositiveInt(q.searchParams.get('limit'), 100);
    var date = q.searchParams.get('date');
    var result = q.searchParams.get('result');
    var className = q.searchParams.get('className');
    var out = SCAN_LOGS.slice().reverse();
    if (date) out = out.filter(function (r) { return r.date === date; });
    if (result) out = out.filter(function (r) { return r.result === result; });
    if (className) out = out.filter(function (r) { return (r.class || '') === className; });
    out = out.slice(0, limit);
    jsonRes(res, req, 200, { scans: out, total: SCAN_LOGS.length });
}

const server = http.createServer((req, res) => {
    const method = req.method;
    const urlPath = new URL(req.url, 'http://x').pathname;
    const urlSearch = new URL(req.url, 'http://x').search;
    if (method === 'OPTIONS') return handleOptions(req, res);
    if (method === 'GET' && urlPath === '/health') return handleHealth(req, res);
    if (method === 'GET' && urlPath === '/api/students') { return handleListStudents(req, res); }
    if (method === 'POST' && urlPath === '/api/students') { return handleUpsertStudent(req, res); }
    if (method === 'DELETE' && urlPath.startsWith('/api/students/')) {
        const sid = decodeURIComponent(urlPath.slice('/api/students/'.length));
        return handleDeleteStudent(req, res, sid);
    }
    if (method === 'GET' && urlPath === '/api/attendance') { return handleList(req, res); }
    if (method === 'GET' && urlPath === '/api/audit') { return handleAudit(req, res); }
    if (method === 'GET' && urlPath === '/api/stats') { return handleStats(req, res); }
    if (method === 'POST' && urlPath === '/api/attendance/correction') { return handleCorrection(req, res); }
    if (method === 'POST' && urlPath === '/api/scans/log') { return handleLogScan(req, res); }
    if (method === 'GET' && urlPath === '/api/scans') { return handleListScans(req, res); }

    // ── Class management (STEP 5) ──
    var segs = pathSegments(req);
    if (segs[0] === 'api' && segs[1] === 'classes') {
        if (segs.length === 2) {
            // /api/classes
            if (method === 'GET') return handleListClasses(req, res);
            if (method === 'POST') return handleCreateClass(req, res);
            return jsonRes(res, req, 405, { error: 'method not allowed' });
        }
        if (segs.length === 3) {
            // /api/classes/:classId
            const classId = segs[2];
            if (method === 'PUT') return handleUpdateClass(req, res, classId);
            if (method === 'DELETE') return handleDeleteClass(req, res, classId);
            if (method === 'GET') return handleListClassStudents(req, res, classId); // list students in this class
            return jsonRes(res, req, 405, { error: 'method not allowed' });
        }
        if (segs.length === 5 && segs[3] === 'students') {
            // /api/classes/:classId/students/:studentId
            const classId = segs[2];
            const studentId = segs[4];
            if (method === 'DELETE') return handleUnassignStudent(req, res, classId, studentId);
            return jsonRes(res, req, 405, { error: 'method not allowed' });
        }
        if (segs.length === 4 && segs[3] === 'students') {
            // /api/classes/:classId/students
            const classId = segs[2];
            if (method === 'POST') return handleAssignStudent(req, res, classId);
            if (method === 'GET') return handleListClassStudents(req, res, classId);
            return jsonRes(res, req, 405, { error: 'method not allowed: use /students or /students/:sid' });
        }
        return jsonRes(res, req, 404, { error: 'not found' });
    }

    jsonRes(res, req, 404, { error: 'not found' });
});

let listener = null;
(async () => {
    try {
        [ATT, LEAVES, CLASSES, CLASS_STUDENTS, SCAN_LOGS, AUDIT, STUDENTS] = await Promise.all([
            loadTable(TBL.ATTENDANCE),
            loadTable(TBL.LEAVES),
            loadTable(TBL.CLASSES),
            loadTable(TBL.CLASS_STUDENTS),
            loadTable(TBL.SCAN_LOG),
            loadTable(TBL.AUDIT),
            loadTable(TBL.STUDENTS),
        ]);
    } catch (e) {
        console.error('[attendance-service] failed to load initial state from Supabase:', e.message);
    }
    listener = server.listen(CONFIG.PORT, () => {
        console.log(`[attendance-service] protected admin service on :${CONFIG.PORT}`);
        console.log(`[attendance-service] persistence: Supabase (${TBL.ATTENDANCE}, ${TBL.LEAVES}, ${TBL.CLASSES}, ${TBL.CLASS_STUDENTS}, ${TBL.SCAN_LOG}, ${TBL.AUDIT})`);
        console.log(`[attendance-service] records loaded: attendance=${ATT.length} leaves=${LEAVES.length} classes=${CLASSES.length} classStudents=${CLASS_STUDENTS.length} scanLogs=${SCAN_LOGS.length} students=${STUDENTS.length}`);
    });
})();
function gracefulShutdown(sig) {
    console.log(`[attendance-service] received ${sig}; closing...`);
    if (listener) listener.close(() => process.exit(0));
    else process.exit(0);
    setTimeout(() => process.exit(1), 2000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = { server, CONFIG, runCorrection, computePreviousStatus, handleCorrection, handleCreateClass, handleListClasses, handleUpdateClass, handleDeleteClass, handleListClassStudents, handleAssignStudent, handleUnassignStudent, handleLogScan, handleListScans };
