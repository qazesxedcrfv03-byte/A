// app.js — Core, UI, Admin, Export
let registeredFaces = [];
let attendanceList  = [];
let leaveList       = [];

// ── Configuration (Global for cross-file access) ──
var CONFIG = {
    FACE_MATCH_THRESHOLD: 0.48,
    FACE_DETECT_MIN_CONFIDENCE: 0.5,
    FACE_TEMPLATE_COUNT: 20,
    FACE_CONFIRM_FRAMES: 3,
    ATTENDANCE_START_TIME: '07:30',
    LATE_TIME: '08:00',
    ATTENDANCE_END_TIME: '08:30',
    // Scan interval (ms) — when a face is detected, responsive frame rate.
    // Derived from MAX_DETECTION_FPS: 1000 / 4 = 250 ms.
    DETECTION_INTERVAL_MS: 250,
    MAX_DETECTION_FPS: 4,
    // Longer interval (ms) used when NO face is in the frame — reduces
    // unnecessary CPU/GPU usage during idle scanning without hurting
    // responsiveness (a new face triggers detection on the next tick).
    NO_FACE_INTERVAL_MS: 450,
    TIMEZONE: 'Asia/Bangkok',
    ADMIN_CREDENTIALS: { user: 'Admin', pass: 'Admin123' },
    // ⚠️ WARNING: Admin credentials are hardcoded in frontend code.
    // This is NOT secure for production. Replace with backend authentication.
    // Current implementation is for DEMO/TESTING only.
    // Evidence storage endpoint (STEP 4): dev-only token embedded here for the demo,
    // matching the app's existing client-side admin model. The server still enforces
    // the token server-side. In production, obtain this token from admin login.
    EVIDENCE_STORAGE: {
        url: '/api/evidence',
        token: '',
    },
    // STEP 9: Protected admin attendance API (server validates + persists to the real DB;
    // the browser never writes this store directly — it POSTs corrections here).
    ATTENDANCE_API: {
        url: '',
        token: '',
    },
    STORAGE_KEYS: {
        students: 'fg_students',
        attendance: 'fg_attendance',
        leaves: 'fg_leaves',
        evidence: 'fg_evidence',
        rosters: 'fg_rosters',
        classes: 'fg_classes'
    },
    ROSTER_WEEK_MAX: 14,    // historical roster weeks (STEP 8)
};

// Runtime config overlay: static-server injects /runtime-config.js (loaded before
// this script) which sets window.__RUNTIME_CONFIG__ with env-sourced tokens and
// optional URL overrides (relative paths for reverse-proxy/HTTPS, or direct
// http://host:port for local dev). This keeps secrets out of the committed source
// while preserving the existing client-side admin model.
if (typeof window !== 'undefined' && window.__RUNTIME_CONFIG__) {
    var _rc = window.__RUNTIME_CONFIG__;
    if (_rc.evidenceUrl)  CONFIG.EVIDENCE_STORAGE.url = _rc.evidenceUrl;
    if (_rc.evidenceToken) CONFIG.EVIDENCE_STORAGE.token = _rc.evidenceToken;
    if (typeof _rc.attendanceUrl !== 'undefined') CONFIG.ATTENDANCE_API.url = _rc.attendanceUrl;
    if (_rc.attendanceToken) CONFIG.ATTENDANCE_API.token = _rc.attendanceToken;
}

// นำค่าที่อาจารย์เคยตั้งไว้ (หน้าตั้งค่า) มาทับค่าเริ่มต้นใน CONFIG ทันทีตอนโหลดสคริปต์
// ต้องทำแบบ synchronous ตรงนี้ (ไม่ใช่รอ async model-load) เพราะ scan.js อ่านค่าพวกนี้จาก CONFIG โดยตรงตอนสแกนจริง
(function applySavedSettingsToConfig() {
    try {
        const raw = localStorage.getItem('fg_settings');
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s.attendanceStartTime) CONFIG.ATTENDANCE_START_TIME = s.attendanceStartTime;
        if (s.lateTime)            CONFIG.LATE_TIME = s.lateTime;
        if (s.attendanceEndTime)   CONFIG.ATTENDANCE_END_TIME = s.attendanceEndTime;
        if (s.faceMatchThreshold)  CONFIG.FACE_MATCH_THRESHOLD = parseFloat(s.faceMatchThreshold);
        if (s.faceMinConfidence)   CONFIG.FACE_DETECT_MIN_CONFIDENCE = parseFloat(s.faceMinConfidence);
        if (s.faceTemplateCount)   CONFIG.FACE_TEMPLATE_COUNT = parseInt(s.faceTemplateCount, 10) || CONFIG.FACE_TEMPLATE_COUNT;
        if (s.faceConfirmFrames)   CONFIG.FACE_CONFIRM_FRAMES = parseInt(s.faceConfirmFrames, 10) || CONFIG.FACE_CONFIRM_FRAMES;
        if (s.timezone)            CONFIG.TIMEZONE = s.timezone;
    } catch (e) { console.error('applySavedSettingsToConfig error:', e); }
})();

// ── Theme (light/dark) toggle ──
// The full light-mode design already lives in style.css ([data-theme="light"] —
// every token, several component overrides). Only the switch itself was missing:
// this reads/writes the SAME fg_settings object every other saved preference uses
// (see applySavedSettingsToConfig above), so it needs no new storage mechanism.
// The actual attribute is set as early as possible by an inline <script> in
// index.html's <head> (before first paint, to avoid a flash of the wrong theme) —
// this just keeps the toggle button + PWA meta color in sync with that after load,
// and handles clicks.
function getSavedTheme() {
    try {
        const s = JSON.parse(localStorage.getItem('fg_settings') || '{}');
        return (s.theme === 'light' || s.theme === 'dark') ? s.theme : null;
    } catch (e) { return null; }
}
function saveTheme(theme) {
    try {
        const s = JSON.parse(localStorage.getItem('fg_settings') || '{}');
        s.theme = theme;
        localStorage.setItem('fg_settings', JSON.stringify(s));
    } catch (e) { console.error('saveTheme error:', e); }
}
function applyTheme(theme) {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');

    const icon = document.getElementById('themeToggleIcon');
    if (icon) icon.textContent = theme === 'light' ? '☀️' : '🌙';
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.setAttribute('aria-label', theme === 'light' ? 'สลับเป็นโหมดมืด' : 'สลับเป็นโหมดสว่าง');
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', theme === 'light' ? '#F5F7FA' : '#0A0E14');
}
function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
    saveTheme(next); // manual choice always wins over prefers-color-scheme from here on
}
function initTheme() {
    // The <head> script already set data-theme before paint using the same saved
    // value or prefers-color-scheme fallback — just sync the button/meta to match.
    const active = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    applyTheme(active);

    // If the admin has never manually picked a theme, keep following the OS setting
    // live. A manual toggle saves an explicit preference (saveTheme), which
    // permanently stops this from overriding it.
    try {
        const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
        if (mq && mq.addEventListener) {
            mq.addEventListener('change', (e) => {
                if (getSavedTheme()) return;
                applyTheme(e.matches ? 'light' : 'dark');
            });
        }
    } catch (e) { /* matchMedia unsupported — manual toggle still works */ }
}

// ── Date Helpers (Thailand / Asia/Bangkok) ──
var DateHelper = {
    today() {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    },
    now() {
        return new Date();
    },
    toThaiTime(date) {
        if (!date) date = new Date();
        return date.toLocaleTimeString('th-TH', { hour12: false, timeZone: CONFIG.TIMEZONE });
    },
    toThaiDate(date) {
        if (!date) date = new Date();
        return date.toLocaleDateString('th-TH', {
            year: 'numeric', month: 'short', day: 'numeric', timeZone: CONFIG.TIMEZONE
        });
    },
    toThaiDateLong(date) {
        if (!date) date = new Date();
        return date.toLocaleDateString('th-TH', {
            year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: CONFIG.TIMEZONE
        });
    },
    isLate(timeStr) {
        if (!timeStr) return false;
        const p = timeStr.split(':');
        if (p.length < 2) return false;
        const h = parseInt(p[0], 10);
        const m = parseInt(p[1], 10);
        const [lh, lm] = CONFIG.LATE_TIME.split(':').map(Number);
        return h > lh || (h === lh && m > lm);
    },
    isAfterEndTime(timeStr) {
        if (!timeStr) return false;
        const p = timeStr.split(':');
        if (p.length < 2) return false;
        const h = parseInt(p[0], 10);
        const m = parseInt(p[1], 10);
        const [eh, em] = CONFIG.ATTENDANCE_END_TIME.split(':').map(Number);
        return h > eh || (h === eh && m >= em);
    },
    normalizeThaiDate(dateStr) {
        if (!dateStr) return dateStr;
        // Convert Buddhist Era year to CE if needed
        const beToCe = (y) => y > 2500 ? y - 543 : y;
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            const year = parseInt(dateStr.substring(0, 4), 10);
            if (year > 2500) {
                const ceYear = beToCe(year);
                return dateStr.substring(0, 4).replace(String(year), String(ceYear));
            }
            return dateStr;
        }
        const dmy = dateStr.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
        if (dmy) {
            const a = parseInt(dmy[1]), b = parseInt(dmy[2]), y = parseInt(dmy[3], 10);
            const ceY = beToCe(y);
            if (a > 12) return `${ceY}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
            if (b > 12) return `${ceY}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
            return `${ceY}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
        }
        return dateStr;
    },
    getAcademicWeekNum(date) {
        if (!date) date = new Date();
        const start = new Date(date.getFullYear(), 4, 1);
        const diff = date - start;
        const weekNum = Math.max(1, Math.min(18, Math.ceil(diff / (7 * 24 * 60 * 60 * 1000))));
        return weekNum;
    },
    // Thai academic year runs May–April. Returns the CE year the academic year is
    // named after (the year most of its months fall in).
    academicYear(date) {
        if (!date) date = new Date();
        const y = date.getFullYear();
        return (date.getMonth() >= 4 ? y : y - 1).toString();
    },
    // Thai school semesters: May–Oct => 1, Nov–Apr => 2.
    academicSemester(date) {
        if (!date) date = new Date();
        const m = date.getMonth();
        return (m >= 4 && m <= 9) ? 1 : 2;
    },
    academicContext(dateStr) {
        const d = typeof dateStr === 'string' ? new Date(dateStr + 'T00:00:00') : (dateStr || new Date());
        return { academicYear: this.academicYear(d), semester: this.academicSemester(d), week: this.getAcademicWeekNum(d) };
    },
    academicYearOptions() {
        const cur = parseInt(this.academicYear(), 10);
        return [cur, cur - 1, cur - 2].filter((y, i, a) => a.indexOf(y) === i);
    }
};

// ── Data Layer Abstraction ──
var DataStore = {
    _storageErrors: [],
    _get(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                console.warn('DataStore: expected array for', key, 'got', typeof parsed);
                return [];
            }
            return parsed;
        } catch (e) {
            console.error('DataStore read error:', key, e);
            DataStore._storageErrors.push({ key, error: e.message });
            return null;
        }
    },
    _set(key, value) {
        try {
            if (!Array.isArray(value)) {
                throw new Error('DataStore: value must be array for ' + key);
            }
            const json = JSON.stringify(value);
            if (json.length > 20 * 1024 * 1024) {
                throw new Error('DataStore: data too large for ' + key);
            }
            localStorage.setItem(key, json);
            return true;
        } catch (e) {
            if (e.name === 'QuotaExceededError' || e.code === 22) {
                showToast('❌ พื้นที่จัดเก็บข้อมูลเต็ม กรุณาลบข้อมูลเก่าบางส่วน');
            } else {
                console.error('DataStore write error:', key, e);
                showToast('❌ ไม่สามารถบันทึกข้อมูลได้: ' + e.message);
            }
            return false;
        }
    },
    getStorageErrors() {
        return DataStore._storageErrors;
    },
    clearStorageErrors() {
        DataStore._storageErrors = [];
    },
    validateStudent(student) {
        if (!student || typeof student !== 'object') return false;
        if (!student.id || typeof student.id !== 'string' || student.id.trim().length === 0) return false;
        if (!student.name || typeof student.name !== 'string' || student.name.trim().length === 0) return false;
        if (!Array.isArray(student.descriptors)) return false;
        if (student.descriptors.length === 0) return false;
        for (const desc of student.descriptors) {
            if (!Array.isArray(desc) || desc.length !== 128) return false;
        }
        return true;
    },
    validateAttendance(record) {
        if (!record || typeof record !== 'object') return false;
        // id is a stable primary key assigned by DataStore.addAttendance so that
        // evidence can be linked to a concrete attendance event. Tolerant:
        // legacy records (no id) remain valid.
        if (record.id != null && (typeof record.id !== 'string' || !record.id.trim())) return false;
        if (!record.studentId || !record.date || !record.time) return false;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date)) return false;
        if (!/^\d{2}:\d{2}(:\d{2})?$/.test(record.time)) return false;
        // Optional forward pointer to evidence. Tolerant so pre-existing records
        // (which have no evidenceId) remain valid — evidence is additive.
        if (record.evidenceId != null && typeof record.evidenceId !== 'string') return false;
        return true;
    },
    // Minimal Attendance Evidence model (see report §12 for full shape).
    // Lives in its own collection (fg_evidence). Relation to Attendance is the
    // composite (studentId + date), which is unique-by-construction for a day.
    validateEvidence(record) {
        if (!record || typeof record !== 'object') return false;
        if (!record.evidenceId || typeof record.evidenceId !== 'string' || record.evidenceId.trim().length === 0) return false;
        if (!record.studentId || typeof record.studentId !== 'string' || record.studentId.trim().length === 0) return false;
        if (!record.date || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) return false;
        if (!record.storageRef || typeof record.storageRef !== 'string') return false;
        if (typeof record.captureAt !== 'number' || isNaN(record.captureAt)) return false;
        if (!record.fileType || typeof record.fileType !== 'string') return false;
        if (typeof record.fileSize !== 'number' || record.fileSize < 0 || isNaN(record.fileSize)) return false;
        if (!record.status || ['available','missing','failed'].indexOf(record.status) === -1) return false;
        if (typeof record.createdAt !== 'number' || isNaN(record.createdAt)) return false;
        // Optional back-reference to the Attendance record's id (ATTENDANCE_ID).
        // Tolerant: evidence without attendanceId remains valid (e.g. unlinked).
        if (record.attendanceId != null && typeof record.attendanceId !== 'string') return false;
        return true;
    },
    validateLeave(leave) {
        if (!leave || typeof leave !== 'object') return false;
        if (!leave.studentId || !leave.date || !leave.type || !leave.reason) return false;
        return true;
    },
    getStudents() {
        const raw = DataStore._get(CONFIG.STORAGE_KEYS.students);
        return raw === null ? [] : raw.filter(s => DataStore.validateStudent(s));
    },
    getAttendance() {
        const raw = DataStore._get(CONFIG.STORAGE_KEYS.attendance);
        return raw === null ? [] : raw.filter(r => DataStore.validateAttendance(r));
    },
    // ── Attendance Evidence ──
    // One attendance event → at most one primary evidence image.
    // The relation is the composite (studentId + date) because that is the
    // unique identity of an attendance record in this app (duplicates are
    // prevented by isAttendedToday / confirmCheckIn). This avoids re-writing
    // or re-keying existing attendance records (non-destructive).
    getEvidence() {
        const raw = DataStore._get(CONFIG.STORAGE_KEYS.evidence);
        return raw === null ? [] : raw.filter(r => DataStore.validateEvidence(r));
    },
    findEvidenceByAttendance(studentId, date) {
        return DataStore.getEvidence().find(e => e.studentId === studentId && e.date === date) || null;
    },
    findEvidenceById(evidenceId) {
        return DataStore.getEvidence().find(e => e.evidenceId === evidenceId) || null;
    },
    hasEvidence(studentId, date) {
        return !!DataStore.findEvidenceByAttendance(studentId, date);
    },
    generateEvidenceId() {
        return 'ev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    },
    // Duplicate protection: (1) evidenceId PK must be unique, (2) only ONE
    // evidence record per attendance event (studentId+date). Returns false
    // if either guard trips — mirrors a Prisma @@unique on the composite.
    addEvidence(record) {
        if (!DataStore.validateEvidence(record)) {
            console.warn('DataStore.addEvidence: invalid evidence record');
            return false;
        }
        const list = DataStore.getEvidence();
        if (list.some(e => e.evidenceId === record.evidenceId)) { console.warn('DataStore.addEvidence: evidenceId already exists'); return false; }
        if (DataStore.findEvidenceByAttendance(record.studentId, record.date)) {
            console.warn('DataStore.addEvidence: evidence already exists for', record.studentId, record.date);
            return false;
        }
        list.push(record);
        return DataStore.saveEvidence(list);
    },
    saveEvidence(list) {
        const valid = list.filter(r => DataStore.validateEvidence(r));
        return DataStore._set(CONFIG.STORAGE_KEYS.evidence, valid);
    },
    removeEvidenceById(evidenceId) {
        const list = DataStore.getEvidence();
        const idx = list.findIndex(e => e.evidenceId === evidenceId);
        if (idx === -1) return false;
        list.splice(idx, 1);
        return DataStore.saveEvidence(list);
    },
    // ── Historical Rosters (STEP 8) ──
    // Membership is historical and scoped to (academicYear, semester, week, className).
    // These methods touch ONLY the roster collection — students, attendance, and face
    // data are never created, deleted, or modified here.
    validateRoster(record) {
        return (typeof RosterModel !== 'undefined') && RosterModel.validateRoster(record);
    },
    getRosters() {
        const raw = DataStore._get(CONFIG.STORAGE_KEYS.rosters);
        if (raw === null) return [];
        if (typeof RosterModel === 'undefined') return [];
        return raw.filter(r => RosterModel.validateRoster(r));
    },
    saveRosters(list) {
        if (typeof RosterModel === 'undefined') return false;
        return DataStore._set(CONFIG.STORAGE_KEYS.rosters, list.filter(r => RosterModel.validateRoster(r)));
    },
    addRoster(record) {
        if (typeof RosterModel === 'undefined' || !RosterModel.validateRoster(record)) {
            console.warn('DataStore.addRoster: invalid record');
            return false;
        }
        const list = DataStore.getRosters();
        const res = RosterModel.addRoster(list, record);
        if (!res.ok) {
            if (res.reason === 'duplicate') {
                console.warn('DataStore.addRoster: roster membership already exists');
            }
            return false;
        }
        return DataStore.saveRosters(res.list);
    },
    removeRoster(index) {
        const list = DataStore.getRosters();
        if (index < 0 || index >= list.length) return false;
        const removed = list[index];
        list.splice(index, 1);
        const ok = DataStore.saveRosters(list);
        // IMPORTANT: this only removes a roster MEMBERSHIP. It does NOT touch the
        // student record, their attendance, or their face data.
        return ok;
    },
    findRosters(query) {
        if (typeof RosterModel === 'undefined') return [];
        return RosterModel.findRosters(DataStore.getRosters(), query || {});
    },
    /* ── Classes (STEP 4 database foundation) ── */
    // Class records live in fg_classes: [{ classId, code, name, createdAt }].
    // This collection is a metadata index of class codes — it does NOT own student
    // membership. Students retain their existing `year` field; classes only reference
    // them by code. Adding/removing a class never touches students/attendance/leaves.
    validateClass(record) {
        return (typeof ClassModel !== 'undefined') ? ClassModel.validateClass(record) : false;
    },
    getClasses() {
        const raw = DataStore._get(CONFIG.STORAGE_KEYS.classes);
        if (raw === null) return [];
        if (typeof ClassModel === 'undefined') return [];
        return raw.filter(r => ClassModel.validateClass(r));
    },
    saveClasses(list) {
        if (typeof ClassModel === 'undefined') return false;
        return DataStore._set(CONFIG.STORAGE_KEYS.classes, list.filter(r => ClassModel.validateClass(r)));
    },
    addClass(record) {
        if (typeof ClassModel === 'undefined' || !ClassModel.validateClass(record)) {
            console.warn('DataStore.addClass: invalid record');
            return false;
        }
        const list = DataStore.getClasses();
        if (list.some(c => c.classId === record.classId)) { console.warn('DataStore.addClass: classId already exists'); return false; }
        if (list.some(c => c.code && record.code && c.code.trim() === record.code.trim())) { console.warn('DataStore.addClass: class code already exists'); return false; }
        list.push(record);
        return DataStore.saveClasses(list);
    },
    removeClass(index) {
        const list = DataStore.getClasses();
        if (index < 0 || index >= list.length) return false;
        list.splice(index, 1);
        return DataStore.saveClasses(list);
    },
    findClassByCode(code) {
        const c = String(code || '').trim();
        return DataStore.getClasses().find(cl => cl.code && cl.code.trim() === c) || null;
    },
    // Safe migration: derive class records from existing student.year values.
    // Does NOT modify students, attendance, or any existing data — only reads
    // student.year and writes the fg_classes collection.
    migrateClassesFromStudents() {
        if (typeof ClassModel === 'undefined') return { ok: false, reason: 'ClassModel not loaded' };
        const students = DataStore.getStudents();
        const existing = DataStore.getClasses();
        const reconciled = ClassModel.reconcileClasses(existing, students);
        const ok = DataStore.saveClasses(reconciled.list);
        return { ok, added: reconciled.added, removed: reconciled.removed.length, total: reconciled.list.length };
    },
    getLeaves() {
        const raw = DataStore._get(CONFIG.STORAGE_KEYS.leaves);
        return raw === null ? [] : raw.filter(r => DataStore.validateLeave(r));
    },
    saveStudents(list) {
        const valid = list.filter(s => DataStore.validateStudent(s));
        return DataStore._set(CONFIG.STORAGE_KEYS.students, valid);
    },
    saveAttendance(list) {
        const valid = list.filter(r => DataStore.validateAttendance(r));
        return DataStore._set(CONFIG.STORAGE_KEYS.attendance, valid);
    },
    saveLeaves(list) {
        const valid = list.filter(r => DataStore.validateLeave(r));
        return DataStore._set(CONFIG.STORAGE_KEYS.leaves, valid);
    },
    getTodayAttendance() {
        const today = DateHelper.today();
        return DataStore.getAttendance().filter(r => r.date === today);
    },
    isAttendedToday(studentId) {
        const today = DateHelper.today();
        return DataStore.getAttendance().some(r => r.studentId === studentId && r.date === today);
    },
    getTodayLeaves() {
        const today = DateHelper.today();
        return DataStore.getLeaves().filter(r => r.date === today);
    },
    addStudent(student) {
        const list = DataStore.getStudents();
        list.push(student);
        return DataStore.saveStudents(list);
    },
    removeStudent(index) {
        const list = DataStore.getStudents();
        if (index < 0 || index >= list.length) return false;
        list.splice(index, 1);
        return DataStore.saveStudents(list);
    },
    findStudentById(id) {
        return DataStore.getStudents().find(s => s.id === id);
    },
    findStudentByName(name) {
        return DataStore.getStudents().find(s => s.name === name);
    },
    addAttendance(record) {
        const list = DataStore.getAttendance();
        // Duplicate-attendance protection at the DB layer: the same student on the
        // same date must not produce a second attendance record (the scanner's
        // isAttendedToday/cooldown is the primary gate; this is the safety net so
        // evidence linking can never multiply attendance events).
        if (list.some(r => r.studentId === record.studentId && r.date === record.date)) {
            console.warn('DataStore.addAttendance: duplicate attendance rejected for', record.studentId, record.date);
            return false;
        }
        // Ensure a stable primary key exists for evidence linkage (Attendance ID).
        if (!record.id || typeof record.id !== 'string' || !record.id.trim()) {
            record.id = DataStore.generateId();
        }
        list.push(record);
        return DataStore.saveAttendance(list);
    },
    findAttendanceById(id) {
        return DataStore.getAttendance().find(r => r.id === id) || null;
    },
    addLeave(leave) {
        const list = DataStore.getLeaves();
        list.push(leave);
        return DataStore.saveLeaves(list);
    },
    removeLeave(index) {
        const list = DataStore.getLeaves();
        if (index < 0 || index >= list.length) return false;
        const target = list[index];
        list.splice(index, 1);
        const ok = DataStore.saveLeaves(list);
        if (ok && typeof auditLog === 'function') {
            auditLog('leave_delete', 'leave', target.id || target.studentId + '_' + target.date, {
                studentId: target.studentId, studentName: target.name, date: target.date,
                reason: target.reason || '', before: { status: target.status, type: target.type }, after: { status: 'deleted' },
                previousStatus: target.status, newStatus: 'deleted',
            });
        }
        return ok;
    },
    setLeaveStatus(index, status) {
        const list = DataStore.getLeaves();
        if (index < 0 || index >= list.length) return false;
        const target = list[index];
        const before = { status: target.status, reason: target.reason, type: target.type };
        list[index].status = status;
        const ok = DataStore.saveLeaves(list);
        // STEP 11: audit leave approval / rejection / status change (never record sensitive data).
        if (ok && typeof auditLog === 'function') {
            const action = status === 'approved' ? 'leave_approve' : status === 'rejected' ? 'leave_reject' : 'leave_status_change';
            auditLog(action, 'leave', target.id || target.studentId + '_' + target.date, {
                studentId: target.studentId, studentName: target.name, date: target.date,
                reason: (target.reason || '') + (status === 'rejected' ? '' : ''),
                before: before, after: { status: target.status, reason: target.reason },
                previousStatus: before.status, newStatus: target.status,
            });
        }
        return ok;
    },
    getAuditLog() {
        try {
            const raw = localStorage.getItem('fg_audit');
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) { console.error('audit read error:', e); return []; }
    },
    saveAudit(entry) {
        try {
            const list = DataStore.getAuditLog();
            list.push(entry);
            localStorage.setItem('fg_audit', JSON.stringify(list));
            return true;
        } catch (e) {
            console.error('audit save error:', e);
            return false;
        }
    },
    // ── Settings (plain object, not array — separate from the _get/_set array helpers above) ──
    getSettings() {
        try {
            const raw = localStorage.getItem('fg_settings');
            return raw ? JSON.parse(raw) : {};
        } catch (e) { console.error('DataStore settings read error:', e); return {}; }
    },
    saveSettings(obj) {
        try {
            localStorage.setItem('fg_settings', JSON.stringify(obj));
            return true;
        } catch (e) {
            console.error('DataStore settings write error:', e);
            showToast('❌ ไม่สามารถบันทึกการตั้งค่าได้: ' + e.message);
            return false;
        }
    }
};

// เก็บสถานะว่าล็อกอินอาจารย์แล้วหรือยังในเซสชันนี้ (ใช้เปิด/ปิดปุ่มอนุมัติใบลา ฯลฯ)
let isAdminSession = false;
let adminSessionUser = '';
var faceModelStatus = 'loading'; // 'loading' | 'ready' | 'error' — tracked by setAIStatus (STEP 8)

// ── Admin Audit Log (STEP 11) ──
// Single entry point for all auditable admin actions. Enforces a consistent,
// SAFE schema: it NEVER serializes face descriptors / embeddings / tokens /
// secrets — only structural before/after snapshots of non-sensitive fields.
const AUDIT_ACTION_LABEL = {
    attendance_correction: 'แก้ไขการเข้าแถว', student_update: 'แก้ไขนักศึกษา', student_delete: 'ลบนักศึกษา',
    roster_add: 'เพิ่มรายชื่อย้อนหลัง', roster_remove: 'ถอดรายชื่อย้อนหลัง', evidence_review: 'ตรวจสอบหลักฐาน',
    leave_approve: 'อนุมัติใบลา', leave_reject: 'ไม่อนุมัติใบลา', leave_delete: 'ลบใบลา',
    clear_attendance: 'ล้างเข้าแถววันนี้', clear_all_data: 'ล้างข้อมูลทั้ยหมด',
};
const AUDIT_ENTITY_LABEL = {
    attendance: 'การเข้าแถว', student: 'นักศึกษา', roster: 'รายชื่อย้อนหลัง',
    evidence: 'หลักฐาน', leave: 'ใบลา', system: 'ระบบ',
};
function currentAdmin() { return isAdminSession ? (adminSessionUser || 'admin') : 'system'; }
function sanitizeAuditObj(o) {
    if (!o || typeof o !== 'object') return null;
    const safe = {};
    const SKIP = /^(descriptors|embedding|embeddings|descriptor|faces|photo|imageData|base64)$/i;
    const SECRETS = /password|token|secret|cookie|jwt|apikey|api_key/i;
    for (const k in o) {
        if (SKIP.test(k) || SECRETS.test(k)) continue;
        const v = o[k];
        if (Array.isArray(v) && k.toLowerCase().indexOf('descriptor') !== -1) continue;
        safe[k] = v;
    }
    return safe;
}
function auditLog(action, entity, entityId, opts = {}) {
    if (!action || !entity) return null;
    const entry = {
        action, entity, entityId: entityId || '',
        admin: opts.admin || currentAdmin(),
        date: opts.date || null,
        studentId: opts.studentId || null,
        studentName: opts.studentName || null,
        reason: opts.reason || '',
        before: sanitizeAuditObj(opts.before),
        after: sanitizeAuditObj(opts.after),
        // Legacy fields (kept so existing attendance-correction entries still render):
        changedBy: opts.admin || currentAdmin(),
        previousStatus: opts.previousStatus || null,
        newStatus: opts.newStatus || null,
        timestamp: opts.timestamp || new Date().toISOString(),
    };
    DataStore.saveAudit(entry);
    return entry;
}

// ── Historical Attendance by Student (Admin: "จัดการรายชื่อทุกสัปดาห์" → แก้ไขเข้าแถว) ──
// Drill-down: Student list (ปวช./ปวส. filterable) -> pick student -> pick week ->
// edit each day's status. Reuses the EXISTING server-authoritative correction API
// (apiAttendanceCorrection), local cache sync (syncCorrectionToCache), audit log
// (auditLog), and status/badge helpers (statusLabel/kindBadgeClass, both already
// updated to include 'holiday') — no separate data store, no duplicate attendance
// system. This is a second navigation path onto the same source of truth as the
// existing date-first Historical tool and the Roster feature it's launched from.
function eduLevelOf(yearStr) {
    const y = String(yearStr || '');
    if (y.indexOf('ปวส') !== -1) return 'ปวส.';
    if (y.indexOf('ปวช') !== -1) return 'ปวช.';
    return 'อื่นๆ';
}
// ปวช. = 18 weeks, ปวส. = 15 weeks. Unclassified ("อื่นๆ") defaults to the wider 18.
function maxWeeksForLevel(level) { return level === 'ปวส.' ? 15 : 18; }
// Returns every date DateHelper.getAcademicWeekNum() itself classifies as week
// `weekNum` (Thai academic year, May 1 start). Deliberately derived by scanning +
// checking against that SAME function rather than a second parallel formula:
// getAcademicWeekNum uses Math.ceil, which makes week 1 span 8 days (May 1-8) and
// every later week exactly 7 — a fixed "start + (w-1)*7" formula silently drifts by
// a day from week 2 onward. Scanning guarantees this always agrees with the
// function attendance-service.js's DateHelperWeek mirrors, so a date shown under
// "week N" here is always scoped as week N when saved.
function weekDateRange(academicYear, weekNum) {
    const may1 = new Date(parseInt(academicYear, 10), 4, 1);
    const days = [];
    for (let i = 0; i < 140; i++) { // 140 days = 20 weeks, comfortably covers weeks 1-18
        // getAcademicWeekNum clamps at 18 (Math.min(18, ...)), so "week 18" would
        // otherwise match every date from late August onward forever — cap the
        // display list at 8 (the longest real week, week 1) so it never balloons.
        if (days.length >= 8) break;
        const d = new Date(may1); d.setDate(may1.getDate() + i);
        if (DateHelper.getAcademicWeekNum(d) === weekNum) {
            days.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
        } else if (days.length > 0) {
            break; // weeks are contiguous blocks, safe to stop once we've passed it
        }
    }
    return days;
}

let histStudentFilter = 'all'; // 'all' | 'ปวช.' | 'ปวส.'
let histStudentSearchQ = '';
let histSelectedStudentId = null;
let histSelectedWeek = null;
let histStudentPendingEdit = null;

function openHistByStudent() {
    if (!isAdminSession) { showToast('❌ กรุณาเข้าสู่ระบบอาจารย์ก่อน'); return; }
    closeModal('adminRosterModal');
    histStudentFilter = 'all';
    histStudentSearchQ = '';
    document.querySelectorAll('.hist-level-tab').forEach(b => b.classList.toggle('active', b.dataset.level === 'all'));
    const q = document.getElementById('histStuSearch');
    if (q) q.value = '';
    renderHistStudentList();
    openModal('histStudentListModal');
}
function setHistStudentFilter(level) {
    histStudentFilter = level;
    document.querySelectorAll('.hist-level-tab').forEach(b => b.classList.toggle('active', b.dataset.level === level));
    renderHistStudentList();
}
function filterHistStudentSearch() {
    const el = document.getElementById('histStuSearch');
    histStudentSearchQ = (el ? el.value : '').trim().toLowerCase();
    renderHistStudentList();
}
function renderHistStudentList() {
    const tbody = document.getElementById('histStudentListBody');
    if (!tbody) return;
    const list = registeredFaces.filter(s => {
        if (histStudentFilter !== 'all' && eduLevelOf(s.year) !== histStudentFilter) return false;
        if (histStudentSearchQ) {
            const hay = ((s.name || '') + ' ' + (s.id || '')).toLowerCase();
            if (hay.indexOf(histStudentSearchQ) === -1) return false;
        }
        return true;
    }).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'th'));

    tbody.innerHTML = list.map(s => {
        const lvl = eduLevelOf(s.year);
        const badgeCls = lvl === 'ปวส.' ? 'badge-blue' : (lvl === 'ปวช.' ? 'badge-green' : 'badge');
        return `<tr class="hist-stu-row" style="cursor:pointer" onclick="openHistStudentWeeks('${escapeHtml(s.id)}')">
            <td style="font-family:var(--font-mono)">${escapeHtml(s.id)}</td>
            <td style="font-weight:600">${escapeHtml(s.name)}</td>
            <td><span class="badge ${badgeCls}">${escapeHtml(lvl)}</span></td>
            <td>${escapeHtml(s.year || '—')}</td>
            <td><button class="btn-secondary btn-sm" onclick="event.stopPropagation();openHistStudentWeeks('${escapeHtml(s.id)}')">เปิด →</button></td>
        </tr>`;
    }).join('');

    const has = list.length > 0;
    const empty = document.getElementById('histStudentListEmpty');
    const table = document.getElementById('histStudentListTable');
    if (empty) empty.style.display = has ? 'none' : 'block';
    if (table) table.style.display = has ? '' : 'none';
}
function openHistStudentWeeks(studentId) {
    const student = DataStore.findStudentById(studentId);
    if (!student) return;
    histSelectedStudentId = studentId;
    histSelectedWeek = null;
    closeModal('histStudentListModal');

    const lvl = eduLevelOf(student.year);
    const ctx = DateHelper.academicContext();
    document.getElementById('histStuName').textContent = student.name;
    document.getElementById('histStuId').textContent = student.id;
    document.getElementById('histStuYear').textContent = student.year || '—';
    document.getElementById('histStuLevel').textContent = lvl;
    document.getElementById('histStuAcademicYear').textContent = ctx.academicYear;
    document.getElementById('histStuSemester').textContent = String(ctx.semester);

    const maxW = maxWeeksForLevel(lvl);
    const weekWrap = document.getElementById('histStuWeekGrid');
    let html = '';
    for (let w = 1; w <= maxW; w++) {
        html += `<button type="button" class="week-btn" data-week="${w}" onclick="selectHistStudentWeek(${w})">สัปดาห์ ${w}</button>`;
    }
    if (weekWrap) weekWrap.innerHTML = html;

    const daysBody = document.getElementById('histStuDaysBody');
    if (daysBody) daysBody.innerHTML = '';
    const daysEmpty = document.getElementById('histStuDaysEmpty');
    if (daysEmpty) daysEmpty.style.display = 'block';

    openModal('histStudentWeeksModal');
}
function backToHistStudentList() {
    closeModal('histStudentWeeksModal');
    openModal('histStudentListModal');
}
function selectHistStudentWeek(w) {
    histSelectedWeek = w;
    document.querySelectorAll('#histStuWeekGrid .week-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.getAttribute('data-week'), 10) === w);
    });
    renderHistStudentDays();
}
function renderHistStudentDays() {
    const student = DataStore.findStudentById(histSelectedStudentId);
    const tbody = document.getElementById('histStuDaysBody');
    const daysEmpty = document.getElementById('histStuDaysEmpty');
    if (!student || !histSelectedWeek || !tbody) return;
    if (daysEmpty) daysEmpty.style.display = 'none';

    const ctx = DateHelper.academicContext();
    const days = weekDateRange(ctx.academicYear, histSelectedWeek);
    const today = DateHelper.today();
    const dayNames = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
    const kindBadge = { present: ['badge-green', '✓ ตรงเวลา'], late: ['badge-yellow', '⏰ มาสาย'], absent: ['badge-red', '✕ ไม่มีข้อมูล'], leave: ['badge-blue', '📝 ลา'], holiday: ['badge-purple', '🎌 วันหยุด'] };

    tbody.innerHTML = days.map(date => {
        const future = date > today;
        const { status, record } = getStudentAttendanceStatus(student.id, date);
        const [badgeCls, badgeLbl] = kindBadge[status];
        const d = new Date(date + 'T00:00:00');
        const dayLabel = dayNames[d.getDay()] + ' ' + date;
        const hasRecord = status !== 'absent';
        const btnLabel = hasRecord ? '✏️ แก้ไข' : '➕ เพิ่ม';
        return `<tr class="hist-day-row" data-date="${escapeHtml(date)}">
            <td>${escapeHtml(dayLabel)}</td>
            <td><span class="badge ${badgeCls}">${badgeLbl}</span></td>
            <td style="font-family:var(--font-mono);font-size:0.82rem">${escapeHtml(record ? (record.time || '—') : '—')}</td>
            <td>
                <select class="hist-stu-status-select form-input" style="font-size:0.82rem;padding:5px 8px;" ${future ? 'disabled' : ''}>
                    <option value="present" ${status === 'present' ? 'selected' : ''}>✓ ตรงเวลา</option>
                    <option value="late" ${status === 'late' ? 'selected' : ''}>⏰ มาสาย</option>
                    <option value="absent" ${status === 'absent' ? 'selected' : ''}>✕ ขาด</option>
                    <option value="leave" ${status === 'leave' ? 'selected' : ''}>📝 ลา</option>
                    <option value="holiday" ${status === 'holiday' ? 'selected' : ''}>🎌 วันหยุด</option>
                </select>
            </td>
            <td><input type="text" class="hist-stu-reason form-input" placeholder="เหตุผล (จำเป็น)" style="font-size:0.78rem;padding:5px 8px;" ${future ? 'disabled' : ''}></td>
            <td><button class="btn-danger-sm" ${future ? 'disabled title="วันในอนาคตยังแก้ไขไม่ได้"' : ''} onclick="saveHistStudentDay(this)">${btnLabel}</button></td>
        </tr>`;
    }).join('');
}
function saveHistStudentDay(btn) {
    if (!isAdminSession) { showToast('❌ ไม่ได้รับอนุญาติ'); return; }
    const row = btn.closest('.hist-day-row');
    if (!row) return;
    const date = row.getAttribute('data-date');
    const studentId = histSelectedStudentId;
    const student = DataStore.findStudentById(studentId);
    if (!student) return;

    const statusSelect = row.querySelector('.hist-stu-status-select');
    const reasonInput = row.querySelector('.hist-stu-reason');
    if (!statusSelect || !reasonInput) return;
    const newStatus = statusSelect.value;
    const reason = reasonInput.value.trim();
    const { status: currentStatus } = getStudentAttendanceStatus(studentId, date);

    if (newStatus === currentStatus) { showToast('⚠️ สถานะเหมือนเดิม ไม่มีการเปลี่ยนแปลง'); return; }
    if (!reason) { showToast('❌ กรุณากรอกเหตุผล'); reasonInput.focus(); return; }

    histStudentPendingEdit = { studentId, date, studentName: student.name, previousStatus: currentStatus, newStatus, reason };

    const content = document.getElementById('histStuEditConfirmContent');
    if (content) {
        content.innerHTML = `
            <div style="text-align:left;font-size:0.85rem;line-height:1.8;">
                <div><span style="color:var(--text-muted)">นักศึกษา:</span> <strong>${escapeHtml(student.name)}</strong> <span style="color:var(--text-muted);font-family:var(--font-mono)">(${escapeHtml(student.id)})</span></div>
                <div><span style="color:var(--text-muted)">วันที่:</span> <strong>${escapeHtml(date)}</strong> (สัปดาห์ ${histSelectedWeek})</div>
                <div><span style="color:var(--text-muted)">สถานะเดิม:</span> <span class="badge ${kindBadgeClass(currentStatus)}">${escapeHtml(statusLabel(currentStatus))}</span></div>
                <div><span style="color:var(--text-muted)">สถานะใหม่:</span> <span class="badge ${kindBadgeClass(newStatus)}">${escapeHtml(statusLabel(newStatus))}</span></div>
                <div><span style="color:var(--text-muted)">เหตุผล:</span> <strong>${escapeHtml(reason)}</strong> <span style="color:var(--text-muted);font-size:0.75rem;">(จำเป็น)</span></div>
            </div>`;
    }
    openModal('confirmHistStuEditModal');
}
function cancelHistStuEdit() {
    histStudentPendingEdit = null;
    closeModal('confirmHistStuEditModal');
}
function confirmHistStuEditSave() {
    if (!isAdminSession) { showToast('❌ ไม่ได้รับอนุญาติ'); closeModal('confirmHistStuEditModal'); return; }
    if (!histStudentPendingEdit) return;

    const saveBtn = document.getElementById('histStuEditConfirmSave');
    if (saveBtn) saveBtn.disabled = true;

    const ed = histStudentPendingEdit;
    const student = DataStore.findStudentById(ed.studentId);
    if (!student) { if (saveBtn) saveBtn.disabled = false; return; }

    const scope = DateHelper.academicContext(ed.date);
    const payload = {
        studentId: ed.studentId, date: ed.date, newStatus: ed.newStatus, previousStatus: ed.previousStatus,
        reason: ed.reason, method: 'แก้ไขย้อนหลัง (รายบุคคล)', admin: adminSessionUser || 'admin',
        academicYear: scope.academicYear, semester: scope.semester, week: scope.week, className: student.year || '',
    };

    showToast('⏳ กำลังบันทึกการแก้ไข...');
    apiAttendanceCorrection(payload)
        .then(function (resp) {
            return resp.json().catch(function () { return {}; }).then(function (data) { return { status: resp.status, body: data }; });
        })
        .then(function (res) {
            if (!res.status || res.status === 401) {
                showToast('❌ ไม่ได้รับอนุญาติ — การแก้ไขล้มเหลว');
            } else if (res.status === 409) {
                var serverStatus = (res.body && res.body.previousStatus) || 'unknown';
                showToast('⚠️ บันทึกไม่สำเร็จ: สถานะเปลี่ยนแล้ว (ปัจจุบัน: ' + statusLabel(serverStatus) + ') กรุณารีเฟรชและลองอีกครั้ง');
            } else if (res.status !== 200) {
                showToast('❌ บันทึกไม่สำเร็จ: ' + ((res.body && res.body.error) || ('รหัส ' + res.status)));
            } else {
                syncCorrectionToCache(ed, res.body);
                auditLog('attendance_correction', 'attendance', ed.recordId || ed.studentId + '_' + ed.date, {
                    studentId: ed.studentId, studentName: ed.studentName, date: ed.date,
                    reason: ed.reason, admin: adminSessionUser || 'admin',
                    before: { status: ed.previousStatus }, after: { status: ed.newStatus },
                    previousStatus: ed.previousStatus, newStatus: ed.newStatus, serverConfirmed: true,
                    recordId: (res.body && res.body.recordId) || ed.recordId || null,
                });
                showToast('✅ บันทึกการเปลี่ยนแปลงแล้ว');
            }
        })
        .catch(function (err) {
            console.error('[admin] student attendance correction failed:', err);
            showToast('❌ ไม่สามารถบันทึกการแก้ไขได้ (เซิร์ฟเวอร์ตอบกลับผิดพลาด)');
        })
        .finally(function () {
            histStudentPendingEdit = null;
            const sb = document.getElementById('histStuEditConfirmSave');
            if (sb) sb.disabled = false;
            closeModal('confirmHistStuEditModal');
            renderHistStudentDays();
            if (typeof updateStats === 'function') updateStats();
        });
}

// ── LocalStorage ──
function loadLocalData() {
    var _tLoad = PM && PM.isEnabled() ? PM.now() : 0;
    let loaded = { students: 0, attendance: 0, leaves: 0 };
    let errors = [];
    
    try {
        const students = DataStore.getStudents();
        registeredFaces = students;
        loaded.students = students.length;
    } catch (e) {
        errors.push('ข้อมูลนักศึกษาสูญหาย');
        registeredFaces = [];
    }
    
    try {
        const attendance = DataStore.getAttendance();
        attendanceList = attendance;
        loaded.attendance = attendance.length;
    } catch (e) {
        errors.push('ข้อมูลเข้าแถวสูญหาย');
        attendanceList = [];
    }
    
    try {
        const leaves = DataStore.getLeaves();
        leaveList = leaves;
        loaded.leaves = leaves.length;
    } catch (e) {
        errors.push('ข้อมูลการลาสูญหาย');
        leaveList = [];
    }
    
    if (errors.length > 0) {
        showToast('⚠️ ' + errors.join(', ') + ' — ระบบทำงานกับข้อมูลที่เหลืออยู่');
    }
    
    // Migrate old date formats
    let migrated = false;
    attendanceList.forEach(r => {
        const norm = DateHelper.normalizeThaiDate(r.date);
        if (norm !== r.date) { r.date = norm; migrated = true; }
        if (r.weekNum === undefined || r.weekNum === null) {
            const d = r.timestamp ? new Date(r.timestamp) : new Date(r.date);
            if (!isNaN(d.getTime())) {
                r.weekNum = DateHelper.getAcademicWeekNum(d);
                migrated = true;
            }
        }
    });
    leaveList.forEach(r => {
        const norm = DateHelper.normalizeThaiDate(r.date);
        if (norm !== r.date) { r.date = norm; migrated = true; }
    });
    if (migrated) {
        DataStore.saveAttendance(attendanceList);
        DataStore.saveLeaves(leaveList);
    }

    migrateEvidenceSchema();
    // STEP 4: Safe migration — derive class records from existing student.year values.
    // Does NOT modify students, attendance, or leaves — only populates fg_classes.
    try { DataStore.migrateClassesFromStudents(); } catch (e) { console.error('class migration error:', e); }
    updateStats();
    if (PM && PM.isEnabled() && typeof _tLoad === 'number') { PM.set('descriptorLoadMs', PM.now() - _tLoad); }
}
function saveStudents()   { DataStore.saveStudents(registeredFaces); }
function saveAttendance() { DataStore.saveAttendance(attendanceList); }
function saveLeaves()     { DataStore.saveLeaves(leaveList); }

// Stable primary key for records (Attendance ID / evidence ID). Uses the Web Crypto
// UUID when available, with a non-collision-prone fallback.
DataStore.generateId = function () {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        try { return crypto.randomUUID(); } catch (e) { /* fall through */ }
    }
    return 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12);
};

// ── Evidence schema migration (non-destructive) ──
// Evidence is stored in a SEPARATE collection (fg_evidence). Existing attendance
// records are NOT modified: a record without linked evidence is a valid
// "zero evidence" state. This migration only guarantees the evidence collection
// loads without throwing on legacy/malformed entries (additive, never deletes
// attendance/leaves/students). Runs once on load; idempotent.
function migrateEvidenceSchema() {
    try {
        const before = DataStore.getEvidence();   // validates + filters malformed (keep valid only)
        if (before.length !== DataStore._get(CONFIG.STORAGE_KEYS.evidence) || true) {
            // Re-persist only if any malformed entries were dropped. _get raw may
            // include unvalidated items that getEvidence() filtered out.
            const raw = DataStore._get(CONFIG.STORAGE_KEYS.evidence);
            if (raw && raw.length !== before.length) DataStore.saveEvidence(before);
        }
    } catch (e) { console.error('migrateEvidenceSchema error:', e); }
}

// ── โหลด AI ──
var _tModelLoad = 0;
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
if (PM && PM.isEnabled()) { _tModelLoad = PM.now(); PM.log('model load start', ''); }
setAIStatus('loading', '🤖 กำลังโหลดโมเดล AI...');
Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
]).then(() => {
    if (PM && PM.isEnabled() && _tModelLoad) { var ms = PM.now() - _tModelLoad; PM.set('modelLoadMs', ms); PM.log('model load', ms); }
    loadLocalData();
    loadUserSettings();
    setAIStatus('ready', '✅ พร้อมสแกน');
    showSection('dashboard'); // แดชบอร์ดเป็นหน้าเริ่มต้น — ไม่เปิดกล้องจนกว่าจะเข้าหน้าสแกน/ลงทะเบียน (ประหยัดทรัพยากร)
}).catch(err => {
    console.error('AI load error:', err);
    let msg = '❌ ไม่สามารถโหลดระบบ AI ได้';
    if (err.message && err.message.includes('fetch')) {
        msg = '❌ ไม่สามารถโหลดโมเดล AI ได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต';
    }
    setAIStatus('error', msg);
});

// Helper: wait for face-api models to finish loading, then invoke `cb`.
// Falls back to polling faceModelStatus if models are not yet ready.
function waitModelsReady(cb) {
    if (typeof cb !== 'function') return;
    if (faceModelStatus === 'ready') { cb(); return; }
    if (faceModelStatus === 'error') { cb(); return; }
    var tries = 0, maxTries = 40; // up to 20s at 500ms intervals
    var iv = setInterval(function () {
        tries++;
        if (faceModelStatus === 'ready' || faceModelStatus === 'error') {
            clearInterval(iv); cb();
        } else if (tries >= maxTries) {
            clearInterval(iv); cb();
        }
    }, 500);
}

function setAIStatus(state, text) {
    faceModelStatus = (state === 'ready') ? 'ready' : (state === 'error') ? 'error' : faceModelStatus;
    const dot = document.getElementById('aiDot');
    const txt = document.getElementById('aiStatusText');
    const banner = document.getElementById('aiErrorBanner');
    if (dot) dot.className = 'status-dot ' + state;
    if (txt) txt.textContent = text.replace(/^[✅❌🤖]\s*/, '');
    // อัปเดตการ์ดสถานะในหน้าสแกนด้วย เฉพาะตอนยังไม่ได้กำลังสแกนอยู่ (กันชนกับสถานะ detecting/recognizing แบบเรียลไทม์ใน scan.js)
    if (typeof isScanning === 'undefined' || !isScanning) {
        if (typeof setStatusCard === 'function') {
            setStatusCard(state === 'error' ? 'unknown' : state === 'ready' ? 'ready' : state === 'loading' ? 'loading' : 'detecting', state === 'ready' ? '✅' : state === 'error' ? '❌' : '🤖', text);
        }
    }
    if (banner) {
        if (state === 'error') {
            banner.style.display = 'flex';
            banner.querySelector('span').textContent = text;
        } else {
            banner.style.display = 'none';
        }
    }
}

// ── กล้อง ──
let currentStream = null;
let cameraActive = false;
let cameraRetryCount = 0;

async function startCamera() {
    if (cameraActive && currentStream) return;
    if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
    cameraRetryCount = Math.min(cameraRetryCount + 1, 3);
    cameraActive = true;
    var _tCam = PM && PM.isEnabled() ? PM.now() : 0;
    try {
        if (!window.isSecureContext) {
            setAIStatus('error', '❌ ต้องใช้ HTTPS หรือ localhost เท่านั้น');
            cameraActive = false;
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            setAIStatus('error', '❌ เบราว์เซอร์ไม่รองรับการเข้าถึงกล้ำ');
            cameraActive = false;
            return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
        });
        currentStream = stream;
        cameraRetryCount = 0;
        const v = document.getElementById('video');
        const v2 = document.getElementById('video2');
        if (v)  { v.srcObject  = stream; v.style.transform  = 'scaleX(-1)'; }
        if (v2) { v2.srcObject = stream; v2.style.transform = 'scaleX(-1)'; }
        await loadCameraList();
        if (PM && PM.isEnabled() && _tCam) { PM.set('cameraInitMs', PM.now() - _tCam); PM.log('camera init', PM.now() - _tCam); }
        setAIStatus('ready', '✅ พร้อมสแกน');
    } catch (err) {
        console.error('Camera error:', err);
        cameraActive = false;
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            setAIStatus('error', '❌ ไม่ได้รับสิทธิ์เข้าถึงกล้ำ กรุณาเปิดสิทธิ์');
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            setAIStatus('error', '❌ ไม่พบกล้ำในอุปกรณ์นี้');
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
            setAIStatus('error', '❌ กล้ำไม่พร้อมใช้งาน หรือใช้งานโดยโปรแกรมอื่น');
        } else if (err.name === 'TypeError' && !window.isSecureContext) {
            setAIStatus('error', '❌ ต้องเปิดใช้งานผ่าน HTTPS หรือ localhost');
        } else {
            setAIStatus('error', '❌ ไม่สามารถเปิดกล้ำได้');
        }
    }
}
function stopCamera() {
    if (currentStream) {
        currentStream.getTracks().forEach(t => t.stop());
        currentStream = null;
        cameraActive = false;
    }
    const v = document.getElementById('video');
    const v2 = document.getElementById('video2');
    if (v)  v.srcObject  = null;
    if (v2) v2.srcObject = null;
}
async function loadCameraList() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter(d => d.kind === 'videoinput');
        const sel = document.getElementById('cameraSelect');
        if (!sel) return;
        sel.innerHTML = '';
        cams.forEach((d, i) => {
            const o = document.createElement('option');
            o.value = d.deviceId;
            o.text  = d.label || `กล้อง ${i+1}`;
            sel.appendChild(o);
        });
    } catch(e) { console.error('loadCameraList error:', e); }
}
async function switchCamera() {
    const sel = document.getElementById('cameraSelect');
    if (!sel) return;
    const id = sel.value;
    stopCamera();
    cameraActive = true;
    try {
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: id ? { exact: id } : undefined }
            });
        } catch (e) {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        }
        currentStream = stream;
        const v  = document.getElementById('video');
        const v2 = document.getElementById('video2');
        if (v)  { v.srcObject  = stream; v.style.transform  = 'scaleX(-1)'; }
        if (v2) { v2.srcObject = stream; v2.style.transform = 'scaleX(-1)'; }
        setAIStatus('ready', '✅ เปลี่ยนกล้ำแล้ว');
    } catch (err) {
        console.error('switchCamera error:', err);
        cameraActive = false;
        currentStream = null;
        setAIStatus('error', '❌ ไม่สามารถเปลี่ยนกล้ำได้');
        await startCamera();
    }
}

// ── Navigation ──
function showSection(name) {
    document.querySelectorAll('.section-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    const section = document.getElementById('section-' + name);
    if (section) section.classList.add('active');
    const navItem = document.querySelector(`[data-section="${name}"]`);
    if (navItem) navItem.classList.add('active');
    const titles = { dashboard:'แดชบอร์ด', scan:'สแกนใบหน้า', register:'ลงทะเบียนใบหน้า', database:'นักศึกษา', attendance:'เข้าแถว', leave:'แจ้งลา', reports:'รายงาน', settings:'ตั้งค่า' };
    document.getElementById('topbarTitle').textContent = titles[name] || name;
    if (name === 'dashboard')  renderDashboard();
    if (name === 'database')   { populateClassFilters(); renderDBTable(); }
    if (name === 'attendance') { populateClassFilters(); renderAttendanceTable(); attendanceViewMode = 'list'; const t = document.getElementById('attendanceCalendarView'); if (t) t.style.display = 'none'; const tc = document.querySelector('#section-attendance .table-card'); if (tc) tc.style.display = ''; const tb = document.getElementById('attendanceViewToggle'); if (tb) tb.textContent = '📅 ปฏิทิน'; }
    if (name === 'leave')      { populateClassFilters(); renderLeaveTable(); }
    if (name === 'reports')    { populateClassFilters(); populateReportRosterFilters(); syncDateRangeFromPeriod(); renderReports(); }
    if (name === 'settings')   loadUserSettings();
    if (name === 'register')   { if (typeof initRegisterUI === 'function') initRegisterUI(); }
    if (window.innerWidth < 768) {
        const sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.classList.remove('open');
        const scrim = document.getElementById('sidebarScrim');
        if (scrim) scrim.classList.remove('open');
        document.body.classList.remove('sidebar-drawer-open');
    }
    // Camera lifecycle: only run the camera on sections that actually use it —
    // stops tracks/frees the device everywhere else to avoid unnecessary battery/CPU use.
    if (name === 'scan' || name === 'register') {
        populateClassFilters();
        if (!cameraActive) startCamera();
        // BUGFIX: leaving 'scan' for 'register' used to skip stopScanning() entirely
        // (both share this branch to keep the camera alive). startScanning() builds
        // its face matcher as a one-time snapshot of registeredFaces, reused for the
        // whole session — so if a scan session was left running, a student registered
        // afterward would never be recognized until a full page reload. Stopping the
        // scan loop on the way to Register (camera stays on, only the stale
        // recognition loop ends) forces a fresh matcher rebuild — including the new
        // student — next time "Start Scanning" is pressed.
        if (name === 'register' && isScanning) stopScanning();
    } else {
        if (isScanning) stopScanning();
        stopCamera();
    }
}
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const hamburger = document.querySelector('.hamburger');
    const scrim = document.getElementById('sidebarScrim');
    if (!sidebar) return;
    const isOpen = sidebar.classList.toggle('open');
    if (scrim) scrim.classList.toggle('open', isOpen);
    if (hamburger) {
        hamburger.classList.toggle('active', isOpen);
        hamburger.setAttribute('aria-expanded', String(isOpen));
        hamburger.setAttribute('aria-label', isOpen ? 'ปิดเมนู' : 'เปิดเมนู');
    }
    // Prevent scroll bleed behind the drawer on touch devices.
    document.body.classList.toggle('sidebar-drawer-open', isOpen);
}

// ── Modal ──
function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.add('open');
    if (id === 'loginModal') {
        const errEl = document.getElementById('loginError');
        if (errEl) errEl.style.display = 'none';
    }
    const firstBtn = m.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (firstBtn) firstBtn.focus();
}
function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('open');
    const triggerMap = { 'loginModal': 'adminBtn', 'confirmRegisterModal': null, 'studentDetailModal': null, 'adminDataModal': null, 'adminDashboardModal': null, 'weekSelectModal': null, 'histAttendanceModal': null, 'confirmHistEditModal': null, 'adminRosterModal': null, 'adminClassModal': null, 'classFormModal': null, 'classStudentModal': null, 'adminScanHistoryModal': null, 'adminHealthModal': null, 'correctionHistoryModal': null, 'histStudentListModal': null, 'histStudentWeeksModal': null, 'confirmHistStuEditModal': null };
    const triggerId = triggerMap[id];
    if (triggerId) {
        const trigger = document.getElementById(triggerId);
        if (trigger) trigger.focus();
    }
}
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    if (typeof hydrateStudentsFromServer === 'function') hydrateStudentsFromServer();
    document.querySelectorAll('.modal-overlay').forEach(o => {
        o.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('open'); });
    });
    document.querySelectorAll('.modal-overlay').forEach(o => {
        o.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') this.classList.remove('open');
            if (e.key === 'Tab') {
                const focusable = this.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
                if (focusable.length === 0) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        });
        const firstFocusable = o.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (firstFocusable) {
            o._firstFocusable = firstFocusable;
        }
    });
    // set default leave date / attendance date filter = today
    const ld = document.getElementById('leaveDate');
    if (ld) ld.value = DateHelper.today();
    const ad = document.getElementById('attendanceDate');
    if (ad) ad.value = DateHelper.today();
    // ── PWA Install (STEP 5 + STEP 6) ──
    let deferredPrompt = null;
    let installHandled = false;
    let browserSupportsInstall = false;
    const installCard = document.getElementById('pwaInstallCard');
    const installStatus = document.getElementById('pwaInstallStatus');
    const installBtn = document.getElementById('topbarInstall');

    function updateInstallUI(state) {
        if (installCard && installStatus) {
            switch (state) {
                case 'installed':
                case 'standalone':
                    installCard.style.display = 'none';
                    break;
                case 'unavailable':
                    installCard.style.display = 'none';
                    break;
                case 'available':
                    installCard.style.display = 'block';
                    installStatus.textContent = 'พร้อมติดตั้ง — กดปุ่มเพื่อเริ่มต้น';
                    break;
                case 'ios':
                    installCard.style.display = 'block';
                    installStatus.innerHTML = 'แตะปุ่ม Share 📤 ด้านล่าง แล้วเลือก <b>"เพิ่มลงใน Home Screen"</b> เพื่อติดตั้งแอป';
                    break;
                case 'prompt-shown':
                    installStatus.textContent = 'กำลังแสดงกล่าวถามการติดตั้ง...';
                    break;
                case 'cancelled':
                    installStatus.textContent = 'ยกเลิกการติดตั้ง — คุณสามารถติดตั้งภายหลังได้';
                    break;
                case 'browser-mode':
                    installCard.style.display = 'none';
                    break;
                default:
                    installCard.style.display = 'none';
            }
        }
        if (installBtn) {
            const showBtn = ['available', 'ios', 'cancelled', 'prompt-shown'].includes(state);
            installBtn.style.display = showBtn ? 'flex' : 'none';
        }
    }

    // Detect standalone mode (installed as PWA) — no user-agent needed
    function isInStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches ||
               window.navigator.standalone === true;
    }

    // Detect iOS (iPhone/iPad) for platforms without beforeinstallprompt
    function isIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    }

    // Check whether the app is already installed or running as a PWA
    if (isInStandalone()) {
        updateInstallUI('standalone');
    }

    window.addEventListener('beforeinstallprompt', (e) => {
        browserSupportsInstall = true;
        e.preventDefault();
        deferredPrompt = e;
        if (!installHandled) {
            updateInstallUI('available');
        }
    });

    // iOS doesn't fire beforeinstallprompt — show guidance instead
    if (!deferredPrompt && isIOS() && !isInStandalone() && !installHandled) {
        // Delay slightly to let beforeinstallprompt fire (it won't on iOS)
        setTimeout(() => {
            if (!deferredPrompt && !isInStandalone() && installCard) {
                updateInstallUI('ios');
            }
        }, 3000);
    }

    // App installed event — fires when user accepts the install
    window.addEventListener('appinstalled', () => {
        console.log('[PWA] App installed');
        deferredPrompt = null;
        installHandled = true;
        updateInstallUI('installed');
    });

    // Display mode change — detects when app transitions to/from standalone
    if (window.matchMedia) {
        window.matchMedia('(display-mode: standalone)').addEventListener('change', (e) => {
            if (e.matches) {
                updateInstallUI('standalone');
            }
        });
    }

    window.installPwaApp = function () {
        if (!deferredPrompt) {
            if (isInStandalone()) {
                if (installStatus) installStatus.textContent = 'แอปถูกติดตั้งแล้ว';
                showToast('📱 ' + 'แอปถูกติดตั้งแล้ว');
                return;
            }
            if (isIOS()) {
                if (installStatus) installStatus.innerHTML = 'แตะปุ่ม Share 📤 ด้านล่าง แล้วเลือก <b>"เพิ่มลงใน Home Screen"</b> เพื่อติดตั้งแอป';
                showToast('📱 แตะปุ่ม Share → เพิ่มลงใน Home Screen');
                return;
            }
            if (browserSupportsInstall) {
                if (installStatus) installStatus.textContent = 'กรุณารีเฟรชหน้าเพื่อลงแอปอีกครั้ง';
                showToast('ℹ️ ' + 'กรุณารีเฟรชหน้าเพื่อติดตั้งแอปอีกครั้ง');
                return;
            }
            if (installStatus) installStatus.textContent = 'การติดตั้งไม่สามารถใช้งานได้ในเบราว์เซอร์นี้';
            showToast('⚠️ ' + 'เบราว์เซอร์ไม่รองรับการติดตั้งแอป');
            return;
        }
        updateInstallUI('prompt-shown');
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                console.log('[PWA] User accepted install');
                installHandled = true;
                updateInstallUI('installed');
                showToast('✅ ' + 'ติดตั้งแอปสำเร็จแล้ว!');
            } else {
                console.log('[PWA] User dismissed install');
                updateInstallUI('cancelled');
                showToast('ℹ️ ' + 'การติดตั้งถูกยกเลิก — สามารถลองอีกครั้งได้');
            }
            deferredPrompt = null;
        });
    };

    // Handle page visibility — stop the camera (release tracks) when the tab is
    // backgrounded or the page is being unloaded, so the camera light/power is freed.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (isScanning) stopScanning();
            if (cameraActive) stopCamera();
        }
    });
    window.addEventListener('beforeunload', () => {
        if (isScanning) stopScanning();
        if (cameraActive) stopCamera();
    });
    window.addEventListener('pagehide', () => {
        if (isScanning) stopScanning();
        if (cameraActive) stopCamera();
    });
});

// ── Security Helpers ──
function escapeHtml(str) {
    if (str == null) return '';
    const s = String(str);
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function sanitizeHtml(html) {
    if (html == null) return '';
    const s = String(html);
    // Only allow specific safe tags used by the system
    const allowed = ['b', 'i', 'u', 'br', 'span'];
    const tagRegex = /<\/?([a-z][a-z0-9]*)[^>]*>/gi;
    return s.replace(tagRegex, (match, tag) => {
        const lower = tag.toLowerCase();
        if (allowed.includes(lower)) {
            return lower === 'span' ? match : match.replace(/\s+[^>]*/g, '');
        }
        return '';
    });
}

// ── Toast ──
function showToast(msg, ms = 3000) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('toast-enter');
    void t.offsetWidth;
    t.classList.add('toast-enter', 'show');
    setTimeout(() => t.classList.remove('show'), ms);
}

// ── Clock ──
function updateClock() {
    const now = new Date();
    const cl = document.getElementById('liveClock');
    const dt = document.getElementById('liveDate');
    if (cl) cl.textContent = now.toLocaleTimeString('th-TH', { hour12:false });
    if (dt) dt.textContent = now.toLocaleDateString('th-TH', { weekday:'short', year:'numeric', month:'short', day:'numeric' });
}
setInterval(updateClock, 1000);
updateClock();

// ── Stats ──
function updateStats() {
    const today = DateHelper.today();
    const attList = DataStore.getTodayAttendance();
    const leaveToday = DataStore.getTodayLeaves();
    const presentIds = new Set(attList.map(r => r.studentId));
    const leaveIds = new Set(leaveToday.map(r => r.studentId));
    const total = DataStore.getStudents().length;
    const attended = total - registeredFaces.filter(s => !presentIds.has(s.id) && !leaveIds.has(s.id)).length;
    const s1 = document.getElementById('statTotal');
    const s2 = document.getElementById('statRegistered');
    const s3 = document.getElementById('statPercent');
    if (s1) s1.textContent = attended;
    if (s2) s2.textContent = total;
    if (s3) s3.textContent = total ? Math.round(attended / total * 100) + '%' : '0%';
}

// ── DB Table (Students) ──
function renderDBTable() {
    const tbody  = document.getElementById('dbBody');
    const empty  = document.getElementById('dbEmpty');
    const table  = document.getElementById('dbTable');
    const cardsWrap = document.getElementById('dbCardsMobile');
    if (!tbody) return;
    const q = (document.getElementById('searchDB')?.value || '').toLowerCase();
    const classF  = document.getElementById('classFilterDB')?.value || 'all';
    const statusF = document.getElementById('statusFilterDB')?.value || 'all';
    const today = DateHelper.today();

    let list = registeredFaces.filter(s => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
    if (classF !== 'all') list = list.filter(s => (s.year||'—') === classF);
    if (statusF !== 'all') {
        list = list.filter(s => {
            const hasAtt   = attendanceList.some(r => r.studentId === s.id && r.date === today);
            const hasLeave = leaveList.some(r => r.studentId === s.id && r.date === today && r.status === 'approved');
            if (statusF === 'present') return hasAtt;
            if (statusF === 'leave')   return !hasAtt && hasLeave;
            return !hasAtt && !hasLeave; // absent (not present, not on leave)
        });
    }

    list = applySort(list, today);
    updateSortIndicators();

    if (list.length === 0) {
        tbody.innerHTML = '';
        if (cardsWrap) cardsWrap.innerHTML = '';
        if (empty) {
            const p = empty.querySelector('p');
            const btnWrap = empty.querySelector('button');
            const hasFilters = q || classF !== 'all' || statusF !== 'all';
            if (p) p.textContent = hasFilters
                ? 'ไม่พบนักศึกษาที่ตรงกับเงื่อนไขที่เลือก'
                : 'ยังไม่มีข้อมูลนักศึกษา';
            if (btnWrap) btnWrap.style.display = hasFilters ? 'none' : '';
            empty.style.display = 'block';
        }
        if (table) table.style.display = 'none';
        return;
    }
    if (empty) empty.style.display = 'none';
    if (table) table.style.display = '';

    // Today's attendance status for a student: Green=Present, Blue=Leave, Red=Absent
    const studentStatus = (s) => studentStatusObj(s, today);

    tbody.innerHTML = list.map((s, i) => {
        const oi = registeredFaces.indexOf(s);
        const cnt = s.descriptors ? s.descriptors.length : 0;
        const faceReady = cnt >= CONFIG.FACE_TEMPLATE_COUNT;
        const st  = studentStatus(s);
        const initial = escapeHtml((s.name||'?').trim().charAt(0));
        const faceIcon = faceReady ? '✓' : (cnt > 0 ? '⋯' : '✕');
        return `<tr onclick="openStudentDetail(${oi})" onkeydown="if(event.key==='Enter'||event.key===' ')openStudentDetail(${oi})" tabindex="0">
            <td><div class="student-row-photo face-status-cell" data-face="${faceReady?'ready':'not-ready'}">${initial}</div></td>
            <td class="student-id-cell" style="font-family:var(--font-mono)">${escapeHtml(s.id)}</td>
            <td class="student-name-cell" style="font-weight:600">${escapeHtml(s.name)}</td>
            <td class="student-year-cell">${escapeHtml(s.year||'—')}</td>
            <td class="student-face-cell"><span class="face-status ${faceReady?'ready':'not-ready'}"><span class="face-dot ${faceReady?'ready':'not-ready'}"></span><span class="face-text">${faceIcon} ${cnt}/${CONFIG.FACE_TEMPLATE_COUNT} มุม</span></span></td>
            <td class="student-status-cell"><span class="badge ${st.cls}">${st.txt}</span></td>
            <td onclick="event.stopPropagation()" class="student-actions-cell"><button class="btn-del" onclick="deleteStudent(${oi})">🗑️ ลบ</button></td>
        </tr>`;
    }).join('');

    if (cardsWrap) {
        cardsWrap.innerHTML = list.map(s => {
            const oi = registeredFaces.indexOf(s);
            const cnt = s.descriptors ? s.descriptors.length : 0;
            const st  = studentStatus(s);
            const faceReady = cnt >= CONFIG.FACE_TEMPLATE_COUNT;
            const faceIcon = faceReady ? '✓' : (cnt > 0 ? '⋯' : '✕');
            return `<div class="student-card-mobile" onclick="openStudentDetail(${oi})" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ')openStudentDetail(${oi})">
                <div class="student-card-header">
                    <div class="student-card-photo">${escapeHtml((s.name||'?').trim().charAt(0))}</div>
                    <div class="student-card-info">
                        <b class="student-card-name">${escapeHtml(s.name)}</b>
                        <span class="badge ${st.cls}">${st.txt}</span>
                    </div>
                </div>
                <div class="student-card-body">
                    <div class="student-card-row"><span class="label">รหัส</span><span class="student-card-id" style="font-family:var(--font-mono)">${escapeHtml(s.id)}</span></div>
                    <div class="student-card-row"><span class="label">ชั้นปี</span><span>${escapeHtml(s.year||'—')}</span></div>
                    <div class="student-card-row"><span class="label">ใบหน้า</span>
                        <span class="face-status ${faceReady?'ready':'not-ready'}">
                            <span class="face-dot ${faceReady?'ready':'not-ready'}"></span>
                            <span class="face-text">${faceIcon} ${cnt}/${CONFIG.FACE_TEMPLATE_COUNT}</span>
                        </span>
                    </div>
                </div>
                <div class="student-card-row card-actions">
                    <button class="btn-secondary btn-sm" onclick="event.stopPropagation();openStudentDetail(${oi})" aria-label="ดูรายละเอียด">👁️</button>
                    <button class="btn-del btn-sm" onclick="event.stopPropagation();deleteStudent(${oi})" aria-label="ลบนักศึกษา">🗑️ ลบ</button>
                </div>
            </div>`;
        }).join('');
    }
}
function filterDB() { renderDBTable(); }

/* ── Student table sorting ── */
let dbSort = { col: 'name', dir: 'asc' };
function sortDB(col) {
    if (dbSort.col === col) {
        dbSort.dir = dbSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        dbSort.col = col;
        dbSort.dir = 'asc';
    }
    renderDBTable();
}
function applySort(list, today) {
    const { col, dir } = dbSort;
    const compare = (a, b) => {
        let av = '', bv = '';
        if (col === 'id')      { av = (a.id||'').toLowerCase(); bv = (b.id||'').toLowerCase(); }
        else if (col === 'name') { av = (a.name||'').toLowerCase(); bv = (b.name||'').toLowerCase(); }
        else if (col === 'year') { av = (a.year||'—').toLowerCase(); bv = (b.year||'—').toLowerCase(); }
        else if (col === 'status') {
            const sa = studentStatusObj(a, today);
            const sb = studentStatusObj(b, today);
            av = sa.txt.toLowerCase(); bv = sb.txt.toLowerCase();
        }
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
        return 0;
    };
    return list.slice().sort(compare);
}
function studentStatusObj(s, today) {
    const hasAtt   = attendanceList.some(r => r.studentId === s.id && r.date === today);
    const hasLeave = leaveList.some(r => r.studentId === s.id && r.date === today && r.status === 'approved');
    if (hasAtt)   return { cls:'badge-green', txt:'✓ มาแล้ว' };
    if (hasLeave) return { cls:'badge-blue',   txt:'ลา' };
    return { cls:'badge-red', txt:'ยังไม่มา' };
}

function updateSortIndicators() {
    document.querySelectorAll('#dbTable th.sortable').forEach(th => {
        th.classList.remove('sorted-asc', 'sorted-desc');
        const indicator = th.querySelector('.sort-indicator');
        if (indicator) indicator.textContent = '↕';
        if (th.dataset.sort === dbSort.col) {
            th.classList.add(dbSort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
            if (indicator) indicator.textContent = dbSort.dir === 'asc' ? '↑' : '↓';
        }
    });
}
function populateClassFilters() {
    const classes = getClassList();
    const opts = '<option value="all">ทุกชั้นปี</option>' + classes.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    ['classFilterDB', 'classFilterAttendance', 'reportClassFilter', 'leaveClassFilter', 'histClassFilter'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const cur = el.value;
        el.innerHTML = opts;
        if (classes.includes(cur) || cur === 'all') el.value = cur;
    });
    // STEP 6: merge server-managed classes into filter dropdowns (admin only)
    if (isAdminSession && classApiBase()) {
        apiListClasses().then(function (data) {
            var serverCodes = (data.classes || []).map(function (c) { return c.code; });
            var allClasses = Array.from(new Set([...classes, ...serverCodes])).sort();
            var merged = '<option value="all">ทุกชั้นปี</option>' + allClasses.map(function (c) { return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>'; }).join('');
    ['classFilterDB', 'classFilterAttendance', 'reportClassFilter', 'leaveClassFilter', 'histClassFilter', 'scanClassFilter'].forEach(id => {
                var el = document.getElementById(id);
                if (!el) return;
                var cur = el.value;
                el.innerHTML = merged;
                if (allClasses.includes(cur) || cur === 'all') el.value = cur;
            });
        }).catch(function () {
            // Silently fall back to local classes only
        });
    }
    const studentSel = document.getElementById('reportStudentFilter');
    if (studentSel) {
        const cur = studentSel.value;
        studentSel.innerHTML = '<option value="all">นักศึกษาทั้งหมด</option>' +
            registeredFaces.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(s.id)})</option>`).join('');
        studentSel.value = cur || 'all';
    }
}
function getClassList(classFilter) {
    let faces = registeredFaces;
    if (classFilter && classFilter !== 'all') faces = faces.filter(s => (s.year||'—') === classFilter);
    const set = new Set(faces.map(s => s.year || '—'));
    return Array.from(set).sort();
}
function deleteStudent(i) {
    if (!confirm(`⚠️ ลบ "${registeredFaces[i].name}" ออกจากระบบ?\n\nรหัส: ${registeredFaces[i].id}\n\nการลบจะไม่สามารถกู้คืนได้!`)) return;
    if (!confirm('⚠️ ยืนยันอีกครรั้ง?\n\nข้อมูลใบหน้าของนักศึกษาคนนี้จะหายไปถาวร!')) return;
    const s = registeredFaces[i];
    auditLog('student_delete', 'student', s.id, {
        studentId: s.id, studentName: s.name, reason: 'ลบนักศึกษาออกจากระบบ',
        before: { name: s.name, year: s.year, faceTemplates: s.descriptors ? s.descriptors.length : 0 },
        after: { deleted: true },
    });
    DataStore.removeStudent(i);
    registeredFaces = DataStore.getStudents();
    renderDBTable(); updateStats();
    showToast('🗑️ ลบข้อมูลแล้ว');
}

// ── Student Detail Modal ──
let currentDetailIndex = null;
function openStudentDetail(i) {
    const s = registeredFaces[i];
    if (!s) return;
    currentDetailIndex = i;
    document.getElementById('sdAvatar').textContent = (s.name||'?').trim().charAt(0);
    document.getElementById('sdName').textContent = s.name;
    document.getElementById('sdSub').textContent = `${s.id} • ${s.year||'—'} • ${s.descriptors?.length||0} มุมที่บันทึก`;
    document.getElementById('sdNameInput').value = s.name;
    document.getElementById('sdYearInput').value = s.year || '';
    const faceCnt = s.descriptors?.length || 0;
    const faceReady = faceCnt >= CONFIG.FACE_TEMPLATE_COUNT;
    const facePct = CONFIG.FACE_TEMPLATE_COUNT > 0 ? Math.min(100, Math.round(faceCnt / CONFIG.FACE_TEMPLATE_COUNT * 100)) : 0;
    const faceEl = document.getElementById('sdFaceRegister');
    if (faceEl) {
        faceEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <span class="face-status ${faceReady?'ready':'not-ready'}">
                    <span class="face-dot ${faceReady?'ready':'not-ready'}"></span>
                    <span class="face-text">${faceReady?'✓':'✕'} ${faceCnt}/${CONFIG.FACE_TEMPLATE_COUNT} มุม</span>
                </span>
                <span style="font-size:0.8rem;color:var(--text-secondary);">${faceReady ? 'ลงทะเบียนใบหน้าเรียบร้อย' : 'ยังไม่ได้ลงทะเบียนใบหน้าเต็มที่'}</span>
            </div>
            <div class="progress-bar" style="height:6px;">
                <div class="progress-fill" style="width:${facePct}%;background:${faceReady?'var(--green)':'var(--red)'};"></div>
            </div>
            ${!faceReady ? '<button class="btn-secondary" style="font-size:0.75rem;padding:4px 10px;margin-top:8px;" onclick="location.href=\'#register\'">🤖 ลงทะเบียนใบหน้า</button>' : ''}
        `;
    }
    const history = attendanceList.filter(r => r.studentId === s.id).slice().reverse().slice(0, 10);
    const hist = document.getElementById('sdHistory');
    hist.innerHTML = history.length === 0
        ? '<p class="dash-empty">ยังไม่มีประวัติการเข้าแถว</p>'
        : history.map(r => `<div class="mini-history-row"><span>${escapeHtml(r.date)} • ${escapeHtml(r.time)}</span><span class="badge ${DateHelper.isLate(r.time)?'badge-yellow':'badge-green'}">${DateHelper.isLate(r.time)?'มาสาย':'ตรงเวลา'}</span></div>`).join('');
    openModal('studentDetailModal');
}
function saveStudentEdit() {
    if (currentDetailIndex === null) return;
    const name = document.getElementById('sdNameInput').value.trim();
    const year = document.getElementById('sdYearInput').value.trim();
    if (!name) { showToast('⚠️ กรุณากรอกชื่อ-นามสกุล'); return; }
    const s = registeredFaces[currentDetailIndex];
    const before = { name: s.name, year: s.year }; // NEVER includes descriptors/embeddings
    registeredFaces[currentDetailIndex].name = name;
    registeredFaces[currentDetailIndex].year = year;
    auditLog('student_update', 'student', s.id, {
        studentId: s.id, studentName: name, reason: 'แก้ไขข้อมูลนักศึกษา',
        before: before, after: { name, year },
    });
    saveStudents();
    renderDBTable(); updateStats();
    showToast('💾 บันทึกการแก้ไขแล้ว');
    closeModal('studentDetailModal');
}
function deleteStudentFromDetail() {
    if (currentDetailIndex === null) return;
    const i = currentDetailIndex;
    closeModal('studentDetailModal');
    deleteStudent(i);
}

// ── Attendance Table ──
// สถานะที่แสดงมี 4 แบบ: present/late (จากบันทึกเช็กชื่อจริง), leave (จากใบลาที่อนุมัติแล้ว),
// absent (คำนวณเฉพาะตอนเลือกวันที่เจาะจง = นักศึกษาที่ไม่มีบันทึกเช็กชื่อและไม่มีใบลาอนุมัติในวันนั้น)
// Builds the filtered attendance rows used by both the table and CSV export (real filters on real data)
function buildAttendanceRows() {
    const q       = (document.getElementById('searchAttendance')?.value || '').toLowerCase();
    const dateVal = document.getElementById('attendanceDate')?.value || '';
    const classF  = document.getElementById('classFilterAttendance')?.value || 'all';
    const statusF = document.getElementById('statusFilterAttendance')?.value || 'all';

    let rows = [];
    if (statusF === 'leave') {
        let leaves = leaveList.filter(r => r.status === 'approved');
        if (dateVal) leaves = leaves.filter(r => r.date === dateVal);
        rows = leaves.map(r => ({ date:r.date, time:'—', studentId:r.studentId, name:r.name, year:r.year, method:'ลาอนุมัติ', kind:'leave' }));
    } else if (statusF === 'absent') {
        if (!dateVal) return [];
        const presentIds = new Set(attendanceList.filter(r => r.date === dateVal).map(r => r.studentId));
        const leaveIds   = new Set(leaveList.filter(r => r.date === dateVal && r.status === 'approved').map(r => r.studentId));
        rows = registeredFaces.filter(s => !presentIds.has(s.id) && !leaveIds.has(s.id))
            .map(s => ({ date:dateVal, time:'—', studentId:s.id, name:s.name, year:s.year, method:'—', kind:'absent' }));
    } else {
        rows = attendanceList
            .filter(r => !dateVal || r.date === dateVal)
            .map(r => ({ date:r.date, time:r.time, studentId:r.studentId, name:r.name, year:r.year, method:r.method||'ใบหน้า (AI)', kind: DateHelper.isLate(r.time) ? 'late' : 'present' }));
        if (statusF === 'present') rows = rows.filter(r => r.kind === 'present');
        if (statusF === 'late')    rows = rows.filter(r => r.kind === 'late');
    }
    if (classF !== 'all') rows = rows.filter(r => (r.year||'—') === classF);
    if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q) || (r.studentId||'').toLowerCase().includes(q));
    return rows;
}
function renderAttendanceTable() {
    const tbody = document.getElementById('attendanceBody');
    const empty = document.getElementById('attendanceEmpty');
    const table = document.getElementById('attendanceTable');
    const cardsWrap = document.getElementById('attendanceCardsMobile');
    if (!tbody) return;

    const dateVal = document.getElementById('attendanceDate')?.value || '';
    const statusF = document.getElementById('statusFilterAttendance')?.value || 'all';
    const rows = buildAttendanceRows();

    if (statusF === 'absent' && !dateVal) {
        tbody.innerHTML = '';
        if (cardsWrap) cardsWrap.innerHTML = '';
        if (empty) { empty.style.display = 'block'; const p = empty.querySelector('p'); if (p) p.textContent = 'เลือกวันที่เพื่อดูรายชื่อที่ขาด'; }
        if (table) table.style.display = 'none';
        return;
    }
    if (rows.length === 0) {
        tbody.innerHTML = '';
        if (cardsWrap) cardsWrap.innerHTML = '';
        if (empty) { empty.style.display = 'block'; const p = empty.querySelector('p'); if (p) p.textContent = 'ยังไม่มีรายชื่อ'; }
        if (table) table.style.display = 'none';
        return;
    }
    if (empty) empty.style.display = 'none';
    if (table) table.style.display = '';

    const kindBadge = { present:['badge-green','✓ ตรงเวลา'], late:['badge-yellow','⏰ มาสาย'], leave:['badge-blue','📝 ลา'], absent:['badge-red','✕ ขาด'] };

    const isModified = (r) => (r.method||'').includes('แก้ไขย้อนหลัง');

    tbody.innerHTML = rows.slice().reverse().map((r, i) => {
        const [cls, lbl] = kindBadge[r.kind] || ['badge-red', r.kind];
        const modified = isModified(r);
        return `<tr onclick="openAttDetail(${JSON.stringify(r).replace(/"/g, '&quot;')})" tabindex="0">
            <td style="color:var(--text-muted);font-family:var(--font-mono)">${i+1}</td>
            <td style="font-family:var(--font-mono)">${escapeHtml(r.date)}</td>
            <td style="font-family:var(--font-mono)">${escapeHtml(r.time)}</td>
            <td style="font-family:var(--font-mono)">${escapeHtml(r.studentId||'—')}</td>
            <td style="font-weight:600">${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.year||'—')}</td>
            <td style="font-size:0.78rem;color:var(--text-muted)">${escapeHtml(r.method)}</td>
            <td><span class="badge ${cls}">${lbl}</span></td>
            <td>${modified ? '<span title="แก้ไขโดยอาจารย์" style="color:var(--yellow);font-size:1.1rem;">✎</span>' : ''}</td>
        </tr>`;
    }).join('');

    if (cardsWrap) {
        cardsWrap.innerHTML = rows.slice().reverse().map((r, i) => {
            const [cls, lbl] = kindBadge[r.kind] || ['badge-red', r.kind];
            const modified = isModified(r);
            return `<div class="student-card-mobile" onclick="openAttDetail(${JSON.stringify(r).replace(/"/g, '&quot;')})" role="button" tabindex="0">
                <div class="student-card-header">
                    <div class="student-card-photo">${escapeHtml((r.name||'?').trim().charAt(0))}</div>
                    <div class="student-card-info">
                        <b class="student-card-name">${escapeHtml(r.name)}</b>
                        <span class="badge ${cls}">${lbl}</span>
                    </div>
                </div>
                <div class="student-card-body">
                    <div class="student-card-row"><span class="label">วันที่</span><span class="student-card-id" style="font-family:var(--font-mono)">${escapeHtml(r.date)}</span></div>
                    <div class="student-card-row"><span class="label">เวลา</span><span style="font-family:var(--font-mono)">${escapeHtml(r.time)}</span></div>
                    <div class="student-card-row"><span class="label">รหัส</span><span class="student-card-id" style="font-family:var(--font-mono)">${escapeHtml(r.studentId||'—')}</span></div>
                    <div class="student-card-row"><span class="label">ชั้นปี</span><span>${escapeHtml(r.year||'—')}</span></div>
                    <div class="student-card-row"><span class="label">วิธี</span><span style="font-size:0.78rem;color:var(--text-muted)">${escapeHtml(r.method)}</span></div>
                    ${modified ? '<div class="student-card-row"><span class="label">✎ แก้ไข</span><span style="color:var(--yellow);font-weight:600;">อาจารย์แก้ไข</span></div>' : ''}
                </div>
            </div>`;
        }).join('');
    }
}
function filterAttendance() { renderAttendanceTable(); }

/* ── Historical Roster (STEP 8) ──
   Student is permanent; roster membership is historical & scoped to
   (academicYear, semester, week, className). Add/remove only mutate the
   roster collection — never students, attendance, or face data. */
function rosterQueryFromUI() {
    const ay  = document.getElementById('rosterYear')?.value || DateHelper.academicYear();
    const sem = document.getElementById('rosterSemester')?.value || DateHelper.academicSemester();
    const wk  = parseInt(document.getElementById('rosterWeek')?.value || '1', 10);
    const cls = document.getElementById('rosterClass')?.value || (registeredFaces.length ? registeredFaces[0].year : '');
    return { academicYear: ay, semester: Number(sem), week: wk, className: cls };
}
function populateRosterSelects() {
    const ySel = document.getElementById('rosterYear');
    const wSel = document.getElementById('rosterWeek');
    const cSel = document.getElementById('rosterClass');
    if (ySel) {
        ySel.innerHTML = '';
        DateHelper.academicYearOptions().forEach(function (y) {
            const opt = document.createElement('option'); opt.value = y; opt.textContent = String(y);
            if (String(y) === DateHelper.academicYear()) opt.selected = true;
            ySel.appendChild(opt);
        });
    }
    if (wSel) {
        wSel.innerHTML = '';
        for (let i = 1; i <= CONFIG.ROSTER_WEEK_MAX; i++) {
            const opt = document.createElement('option'); opt.value = i; opt.textContent = `สัปดาห์ ${i}`;
            wSel.appendChild(opt);
        }
        wSel.value = String(Math.min(DateHelper.getAcademicWeekNum() || 1, CONFIG.ROSTER_WEEK_MAX));
    }
    if (cSel) {
        cSel.innerHTML = '';
        const years = [];
        registeredFaces.forEach(s => { if (s.year && years.indexOf(s.year) === -1) years.push(s.year); });
        years.sort();
        if (years.length === 0) years.push('—');
        years.forEach(function (y) {
            const opt = document.createElement('option'); opt.value = y; opt.textContent = y;
            cSel.appendChild(opt);
        });
    }
}
function openAdminRoster() {
    if (!isAdminSession) { showToast('❌ กรุณาเข้าสู่ระบบอาจารย์ก่อน'); return; }
    populateRosterSelects();
    refreshRosterAdded();
    renderRosterSearchResults();
    openModal('adminRosterModal');
}
function refreshRosterAdded() {
    const q = rosterQueryFromUI();
    const rows = DataStore.findRosters(q);
    const body = document.getElementById('rosterAddedBody');
    const cnt  = document.getElementById('rosterCount');
    if (cnt) cnt.textContent = rows.length;
    if (!body) return;
    if (rows.length === 0) {
        body.innerHTML = '<tr><td colspan="5" class="empty-table-cell">ยังไม่มีนักศึกษาในรายชื่อสัปดาห์นี้</td></tr>';
        return;
    }
    // Stable order by addedAt desc. Re-derive the live roster index for removal.
    const live = DataStore.getRosters();
    body.innerHTML = rows.map(function (r) {
        const idx = live.findIndex(function (x) { return x.rosterId === r.rosterId; });
        const student = DataStore.findStudentById(r.studentId) || {};
        return '<tr>'
            + '<td class="student-actions-cell" style="font-weight:600">' + escapeHtml(r.name || student.name || '—') + '</td>'
            + '<td style="font-family:var(--font-mono)">' + escapeHtml(r.studentId || student.id || '—') + '</td>'
            + '<td>' + escapeHtml(r.className || student.year || '—') + '</td>'
            + '<td style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-muted)">' + DateHelper.toThaiDate(new Date(r.addedAt)) + '</td>'
            + '<td><button class="btn-del btn-sm" onclick="removeStudentFromRoster(' + idx + ')">ถอด</button></td>'
            + '</tr>';
    }).join('');
}
function searchRosterStudent() {
    const q = (document.getElementById('rosterSearch')?.value || '').trim().toLowerCase();
    renderRosterSearchResults(q);
}
function renderRosterSearchResults(query) {
    const body = document.getElementById('rosterSearchResultsBody');
    if (!body) return;
    const q = (query || '').toLowerCase();
    if (!q) {
        body.innerHTML = '<tr><td colspan="4" class="empty-table-cell">พิมพ์ชื่อหรือรหัสแล้วกดค้นหา</td></tr>';
        return;
    }
    const fq = rosterQueryFromUI();
    const matches = registeredFaces.filter(s => {
        if (!s.id || !s.name) return false;
        return (String(s.id).toLowerCase().indexOf(q) !== -1) || (String(s.name).toLowerCase().indexOf(q) !== -1);
    });
    if (fq.studentId) { /* no-op */ }
    if (matches.length === 0) {
        body.innerHTML = '<tr><td colspan="4" class="empty-table-cell">ไม่พบนักศึกษา</td></tr>';
        return;
    }
    body.innerHTML = matches.map(function (s) {
        const already = DataStore.findRosters(fq).some(function (r) { return r.studentId === s.id; });
        const addBtn = already
            ? '<span class="badge badge-green">✓ มีอยู่แล้ว</span>'
            : '<button class="btn-primary btn-sm" onclick="addStudentToRoster(' + JSON.stringify(s).replace(/"/g, '&quot;') + ')">เพิ่ม</button>';
        return '<tr>'
            + '<td class="student-actions-cell" style="font-weight:600">' + escapeHtml(s.name) + '</td>'
            + '<td style="font-family:var(--font-mono)">' + escapeHtml(s.id || '—') + '</td>'
            + '<td>' + escapeHtml(s.year || '—') + '</td>'
            + '<td>' + addBtn + '</td>'
            + '</tr>';
    }).join('');
}
function addStudentToRoster(student) {
    if (!isAdminSession) return;
    const fq = rosterQueryFromUI();
    if (!fq.academicYear || !fq.week || !fq.className) { showToast('⚠️ กรุณาเลือกปี/ภาค/สัปดาห์/ชั้น'); return; }
    const record = {
        rosterId: DataStore.generateId(),
        studentId: student.id,
        name: student.name,           // denormalized for convenience (source of truth = student)
        academicYear: fq.academicYear,
        semester: fq.semester,
        week: fq.week,
        className: fq.className,
        addedAt: Date.now(),
        addedBy: adminSessionUser || 'admin',
    };
    const ok = DataStore.addRoster(record);
    if (ok) {
        auditLog('roster_add', 'roster', record.rosterId, {
            studentId: record.studentId, studentName: record.name, date: record.date || null,
            reason: '', before: null, after: { academicYear: record.academicYear, semester: record.semester, week: record.week, className: record.className },
        });
        showToast('✅ เพิ่ม ' + (student.name || '-') + ' เข้าสัปดาห์ ' + fq.week);
        refreshRosterAdded();
        renderRosterSearchResults(document.getElementById('rosterSearch')?.value || '');
    } else {
        showToast('⚠️ มีนักศึกษาคนนี้อยู่ในรายชื่อสัปดาห์นี้แล้ว');
    }
}
function removeStudentFromRoster(index) {
    if (!isAdminSession) return;
    const live = DataStore.getRosters();
    if (index < 0 || index >= live.length) return;
    const target = live[index];
    if (!confirm(`ถอด ${target.name || target.studentId} ออกจากรายชื่อสัปดาห์ที่ ${target.week} ปีการศึกษา ${target.academicYear} ภาค ${target.semester}?\n\nนักศึกษา ข้อมูลการเข้าแถว และใบหน้า จะไม่ถูกลบ`)) return;
    const ok = DataStore.removeRoster(index);
    if (ok) {
        auditLog('roster_remove', 'roster', target.rosterId || target.studentId, {
            studentId: target.studentId, studentName: target.name || '',
            reason: '', date: target.date || null,
            before: { academicYear: target.academicYear, semester: target.semester, week: target.week, className: target.className }, after: { removed: true },
        });
        showToast('✅ ถอดนักศึกษาออกจากรายชื่อแล้ว'); refreshRosterAdded();
    }
}

/* ── Attendance detail modal ── */
function openAttDetail(r) {
    const kind = r.kind || 'absent';
    const kindBadge = { present:['badge-green','✓ ตรงเวลา'], late:['badge-yellow','⏰ มาสาย'], leave:['badge-blue','📝 ลา'], absent:['badge-red','✕ ขาด'] };
    const [cls, lbl] = kindBadge[kind] || ['badge-red', kind];
    const modified = (r.method||'').includes('แก้ไขย้อนหลัง');
    document.getElementById('attAvatar').textContent = (r.name||'?').trim().charAt(0);
    document.getElementById('attDetailName').textContent = r.name || '—';
    document.getElementById('attDetailSub').textContent = `${r.studentId||'—'} • ${r.year||'—'}`;
    document.getElementById('attDate').textContent = r.date || '—';
    document.getElementById('attTime').textContent = r.time || '—';
    document.getElementById('attId').textContent = r.studentId || '—';
    document.getElementById('attYear').textContent = r.year || '—';
    const badge = document.getElementById('attStatusBadge');
    if (badge) { badge.className = 'badge ' + cls; badge.textContent = lbl; }
    document.getElementById('attMethod').textContent = r.method || '—';
    const modEl = document.getElementById('attModified');
    if (modEl) modEl.innerHTML = modified
        ? '<span style="color:var(--yellow);font-weight:600;">✓ มีการแก้ไขโดยอาจารย์</span>'
        : '<span style="color:var(--text-muted);">ไม่มี</span>';

    // ── Evidence review (admin-only) ──
    const slot   = document.getElementById('attEvidenceSlot');
    const img    = document.getElementById('attEvidenceImg');
    const empty  = document.getElementById('attEvidenceEmpty');
    const load   = document.getElementById('attEvidenceLoading');
    const ci     = document.getElementById('attConfidenceItem');
    const cv     = document.getElementById('attConfidence');
    if (slot) slot.style.display = isAdminSession ? 'block' : 'none';
    if (img) { img.classList.remove('loaded'); img.src = ''; img.style.display = 'none'; }
    if (empty) empty.style.display = 'none';
    if (load)  load.style.display = 'none';

    // Confidence: show ONLY if an existing score is present on the record (never invent one).
    if (ci) {
        if (r.confidence != null && r.confidence !== '' && Number(r.confidence) >= 0) {
            if (cv) cv.textContent = Number(r.confidence) + '%';
            ci.style.display = '';
        } else {
            ci.style.display = 'none';
        }
    }

    if (isAdminSession && r.evidenceId) {
        auditLog('evidence_review', 'evidence', r.evidenceId, {
            studentId: r.studentId, studentName: r.name, date: r.date, reason: 'ตรวจสอบหลักฐานการเข้าแถว',
        });
        if (load) load.style.display = 'block';
        loadEvidenceImage(r.evidenceId, img, empty, load);
    } else if (isAdminSession && !r.evidenceId) {
        // Admin opened a record that has no linked evidence.
        if (empty) empty.style.display = 'block';
    }
    openModal('attDetailModal');
}

// Fetch one evidence image through the secure, token-gated endpoint.
// Resolves to an object URL blob (never exposes a raw server URL). Failure is graceful
// (shows the no-evidence placeholder) and never throws to the caller.
function loadEvidenceImage(evidenceId, imgEl, emptyEl, loadingEl) {
    var cfg = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.EVIDENCE_STORAGE) ? CONFIG.EVIDENCE_STORAGE : null;
    if (!cfg || !cfg.token) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }
    // GET /api/evidence/:id  (cfg.url is the POST endpoint ".../api/evidence")
    var base = cfg.url.replace(/\/+$/, '');
    var url  = base + '/' + encodeURIComponent(evidenceId);
    fetch(url, { headers: { 'Authorization': 'Bearer ' + cfg.token } })
        .then(function (resp) {
            if (!resp.ok) throw new Error('http ' + resp.status);
            return resp.blob();
        })
        .then(function (blob) {
            var type = (blob && blob.type) || '';
            if (type.indexOf('image/') !== 0) throw new Error('non-image blob');
            var obj = URL.createObjectURL(blob);
            if (loadingEl) loadingEl.style.display = 'none';
            if (imgEl) {
                imgEl.onload  = function () { URL.revokeObjectURL(obj); };
                imgEl.onerror = function () { URL.revokeObjectURL(obj); if (emptyEl) emptyEl.style.display = 'block'; };
                imgEl.src = obj;
                imgEl.classList.add('loaded');
                imgEl.style.display = 'block';
            }
            if (emptyEl) emptyEl.style.display = 'none';
        })
        .catch(function (err) {
            console.error('[attDetail] evidence load failed:', err);
            if (loadingEl) loadingEl.style.display = 'none';
            if (imgEl) { imgEl.src = ''; imgEl.classList.remove('loaded'); imgEl.style.display = 'none'; }
            if (emptyEl) emptyEl.style.display = 'block';
        });
}
function isLate(t) {
    return DateHelper.isLate(t);
}
function clearAttendance() {
    const today = DateHelper.today();
    if (!confirm(`ล้างรายชื่อวันนี้ (${DateHelper.toThaiDate()})?\n\nข้อมูลทั้งหมดของวันนี้จะหายไป และไม่สามารถกู้คืนได้!`)) return;
    if (!confirm('⚠️ ยืนยันอีกครั้ง?\n\nข้อมูลจะหายไปถาวร!')) return;
    const cleared = attendanceList.filter(r => r.date === today).length;
    auditLog('clear_attendance', 'attendance', '*', { date: today, previousStatus: `${cleared} รายชื่อ`, newStatus: 'ล้างทั้งหมด', reason: '' });
    attendanceList = attendanceList.filter(r => r.date !== today);
    saveAttendance(); renderAttendanceTable(); updateStats();
    showToast('🗑️ ล้างรายชื่อวันนี้แล้ว');
}
function clearAllData() {
    if (!confirm('⚠️ ล้างข้อมูลทั้งหมด?\n\nจะลบ:\n- รายชื่อเข้าแถวทั้งหมด\n- ประวัติการลาทั้งหมด\n\nไม่สามารถกู้คืนได้!')) return;
    if (!confirm('⚠️ ยืนยันอีกครั้ง?\n\nข้อมูลจะหายไปถาวร และไม่สามารถกู้คืนได้!')) return;
    const attCount = attendanceList.length;
    const leaveCount = leaveList.length;
    auditLog('clear_all_data', 'system', '*', {
        date: DateHelper.today(), previousStatus: `${attCount} เข้าแถว, ${leaveCount} ใบลา`, newStatus: 'ล้างทั้งหมด',
        reason: '', studentName: 'ระบบทั้งหมด',
        before: { attendance: attCount, leaves: leaveCount }, after: { attendance: 0, leaves: 0 },
    });
    attendanceList = [];
    leaveList = [];
    saveAttendance();
    saveLeaves();
    renderAttendanceTable();
    renderLeaveTable();
    updateStats();
    showToast('🗑️ ล้างข้อมูลทั้งหมดแล้ว');
    closeModal('adminDashboardModal');
}

// ── Attendance Calendar ──
let calCurrentDate = new Date();
let attendanceViewMode = 'list';

function buildCalendarData(year, month) {
    const days = [];
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const totalDays = lastDay.getDate();
    const startWeekday = firstDay.getDay();
    const totalStudents = registeredFaces.length;

    for (let i = 0; i < startWeekday; i++) {
        days.push({ empty: true });
    }

    for (let d = 1; d <= totalDays; d++) {
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const dayAtt = attendanceList.filter(r => r.date === dateStr);
        const dayLeave = leaveList.filter(r => r.date === dateStr && r.status === 'approved');
        const present = dayAtt.filter(r => !DateHelper.isLate(r.time)).length;
        const late = dayAtt.filter(r => DateHelper.isLate(r.time)).length;
        const leave = dayLeave.length;
        const absent = totalStudents > 0 ? Math.max(0, totalStudents - present - late - leave) : 0;
        const hasData = dayAtt.length > 0 || dayLeave.length > 0;
        const modified = dayAtt.some(r => (r.method||'').includes('แก้ไขย้อนหลัง'));

        let statusCat = 'no-data';
        if (hasData && totalStudents > 0) {
            const absentRate = absent / totalStudents;
            const lateRate = late / totalStudents;
            if (absentRate > 0.30) statusCat = 'high-absent';
            else if (lateRate > 0.30) statusCat = 'high-late';
            else if (modified) statusCat = 'modified';
            else statusCat = 'normal';
        }

        days.push({
            date: dateStr,
            dayNum: d,
            weekday: new Date(year, month, d).getDay(),
            isToday: dateStr === DateHelper.today(),
            present, late, absent, leave,
            total: totalStudents,
            hasData, modified,
            statusCat
        });
    }

    while (days.length < startWeekday + totalDays + (7 - (startWeekday + totalDays) % 7) % 7) {
        days.push({ empty: true });
    }

    return days;
}

function renderCalendar() {
    const titleEl = document.getElementById('calendarTitle');
    if (titleEl) {
        const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กระษัตร์','สิงหาคม','กันยายน','ตุลาคม','พฤศจินย์','ธันวาคม'];
        const month = calCurrentDate.getMonth();
        const year = calCurrentDate.getFullYear();
        const thaiYear = year + 543;
        titleEl.textContent = `${months[month]} ${thaiYear}`;
    }

    const days = buildCalendarData(calCurrentDate.getFullYear(), calCurrentDate.getMonth());
    const container = document.getElementById('calendarDays');
    if (!container) return;

    const statusClass = {
        'normal':       'cal-day-normal',
        'high-absent':  'cal-day-high-absent',
        'high-late':    'cal-day-high-late',
        'modified':     'cal-day-modified',
        'no-data':      'cal-day-gray'
    };

    container.innerHTML = days.map(day => {
        if (day.empty) return '<div class="cal-day cal-day-empty"></div>';
        const cls = statusClass[day.statusCat] || 'cal-day-gray';
        const isToday = day.isToday ? ' cal-day-today' : '';

        let summary = '';
        if (day.hasData) {
            const badges = [];
            if (day.present > 0)  badges.push(`<span class="cal-mini-badge cal-green">✓ ${day.present}</span>`);
            if (day.late > 0)     badges.push(`<span class="cal-mini-badge cal-yellow">⏰ ${day.late}</span>`);
            if (day.absent > 0)   badges.push(`<span class="cal-mini-badge cal-red">✕ ${day.absent}</span>`);
            if (day.leave > 0)    badges.push(`<span class="cal-mini-badge cal-blue">📝 ${day.leave}</span>`);
            summary = badges.join('');
        } else {
            summary = '<span class="cal-mini-none">—</span>';
        }

        return `<div class="cal-day ${cls}${isToday}" onclick="openCalDay('${day.date}')">
            <div class="cal-day-num">${day.dayNum}</div>
            <div class="cal-day-summary">${summary}</div>
        </div>`;
    }).join('');
}

function toggleAttendanceView() {
    const tableCard = document.querySelector('#section-attendance .table-card');
    const calView = document.getElementById('attendanceCalendarView');
    const toggleBtn = document.getElementById('attendanceViewToggle');
    if (!tableCard || !calView || !toggleBtn) return;

    if (attendanceViewMode === 'list') {
        tableCard.style.display = 'none';
        calView.style.display = 'block';
        attendanceViewMode = 'calendar';
        calCurrentDate = new Date();
        renderCalendar();
        toggleBtn.textContent = '📋 รายชื่อ';
    } else {
        tableCard.style.display = '';
        calView.style.display = 'none';
        attendanceViewMode = 'list';
        toggleBtn.textContent = '📅 ปฏิทิน';
    }
}

function prevMonth() {
    calCurrentDate.setMonth(calCurrentDate.getMonth() - 1);
    renderCalendar();
}

function nextMonth() {
    calCurrentDate.setMonth(calCurrentDate.getMonth() + 1);
    renderCalendar();
}

function openCalDay(dateStr) {
    if (!isAdminSession) {
        showToast('❌ เข้าสู่ระบบอาจารย์เพื่อแก้ไข');
        return;
    }
    const dateEl = document.getElementById('histDate');
    if (dateEl) dateEl.value = dateStr;
    openAdminHistorical();
}
function exportCSV(type) {
    let rows = [], filename = '';
    const today = DateHelper.today();
    if (type === 'students') {
        rows.push(['รหัส','ชื่อ-นามสกุล','ชั้นปี','มุมที่บันทึก']);
        registeredFaces.forEach(s => rows.push([s.id, s.name, s.year||'', s.descriptors?.length||0]));
        filename = `students_${today}.csv`;
    } else if (type === 'attendance') {
        const statusTh = { present:'ตรงเวลา', late:'มาสาย', leave:'ลา', absent:'ขาด' };
        rows.push(['วันที่','เวลา','รหัส','ชื่อ-นามสกุล','ชั้นปี','วิธีตรวจสอบ','สถานะ']);
        buildAttendanceRows().forEach(r => rows.push([r.date, r.time, r.studentId||'', r.name, r.year||'', r.method||'', statusTh[r.kind]||'']));
        filename = `attendance_${today}.csv`;
    } else if (type === 'leave') {
        rows.push(['ชื่อ','รหัส','ชั้นปี','ประเภทการลา','วันที่ลา','เหตุผล','สถานะ']);
        const statusTh = { pending:'รออนุมัติ', approved:'อนุมัติแล้ว', rejected:'ไม่อนุมัติ' };
        leaveList.forEach(r => rows.push([r.name||'', r.studentId||'', r.year||'', r.type, r.date, r.reason||'', statusTh[r.status||'pending']]));
        filename = `leave_${today}.csv`;
    } else if (type === 'all') {
        rows.push(['=== ข้อมูลนักศึกษา ===']); rows.push(['รหัส','ชื่อ','ชั้นปี']);
        registeredFaces.forEach(s => rows.push([s.id, s.name, s.year||'']));
        rows.push([]); rows.push(['=== รายชื่อเข้าแถว ===']); rows.push(['วันที่','เวลา','รหัส','ชื่อ','สถานะ']);
        attendanceList.forEach(r => rows.push([r.date, r.time, r.studentId||'', r.name, DateHelper.isLate(r.time)?'มาสาย':'ตรงเวลา']));
        rows.push([]); rows.push(['=== ประวัติลา ===']); rows.push(['ชื่อ','รหัส','ชั้นปี','ประเภท','วันที่ลา','เหตุผล','สถานะ']);
        leaveList.forEach(r => rows.push([r.name||'', r.studentId||'', r.year||'', r.type, r.date, r.reason||'', r.status||'pending']));
        filename = `export_all_${today}.csv`;
    }
    const csv  = '\uFEFF' + rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    showToast('📥 Export สำเร็จ!');
}

// Reports CSV export — respects all report-page filters (date range, class, student, status)
function exportReportsCSV() {
    const { start, end } = reportDateRange();
    const classF   = document.getElementById('reportClassFilter')?.value || 'all';
    const studentF = document.getElementById('reportStudentFilter')?.value || 'all';
    const statusF  = document.getElementById('reportStatusFilter')?.value || 'all';

    let students = registeredFaces;
    if (classF !== 'all') students = students.filter(s => (s.year||'—') === classF);
    if (studentF !== 'all') students = students.filter(s => s.id === studentF);
    const studentIds = new Set(students.map(s => s.id));

    const attInRange = attendanceList.filter(r => r.date >= start && r.date <= end && studentIds.has(r.studentId));
    const leaveInRange = leaveList.filter(r => r.date >= start && r.date <= end && r.status === 'approved' && studentIds.has(r.studentId));

    const schoolDays = Array.from(new Set(attendanceList.filter(r => r.date >= start && r.date <= end).map(r => r.date))).sort();
    const totalSlots = students.length * schoolDays.length;

    const rows = [];

    rows.push(['=== ข้อมูลนักศึกษา ===']);
    rows.push(['รหัส','ชื่อ-นามสกุล','ชั้นปี']);
    students.forEach(s => rows.push([s.id, s.name, s.year||'']));
    rows.push([]);

    const showPresent = (statusF === 'all' || statusF === 'present');
    const showLate    = (statusF === 'all' || statusF === 'late');
    const showAbsent  = (statusF === 'all' || statusF === 'absent');
    const showLeave   = (statusF === 'all' || statusF === 'leave');

    if (showPresent || showLate) {
        rows.push(['=== เข้าแถว ===']);
        rows.push(['วันที่','เวลา','รหัส','ชื่อ-นามสกุล','ชั้นปี','วิธีตรวจสอบ','สถานะ']);
        attInRange
            .filter(r => {
                if (showPresent && showLate) return true;
                if (showPresent) return !DateHelper.isLate(r.time);
                if (showLate) return DateHelper.isLate(r.time);
                return false;
            })
            .sort((a,b) => (a.date+b.time).localeCompare(b.date+b.time))
            .forEach(r => rows.push([r.date, r.time, r.studentId||'', r.name, r.year||'', r.method||'ใบหน้า (AI)', DateHelper.isLate(r.time)?'มาสาย':'ตรงเวลา']));
        rows.push([]);
    }

    if (showAbsent) {
        rows.push(['=== ขาด ===']);
        rows.push(['วันที่','รหัส','ชื่อ-นามสกุล','ชั้นปี']);
        const leaveIdsByDate = new Map();
        leaveInRange.forEach(r => {
            if (!leaveIdsByDate.has(r.date)) leaveIdsByDate.set(r.date, new Set());
            leaveIdsByDate.get(r.date).add(r.studentId);
        });
        const attIdsByDate = new Map();
        attInRange.forEach(r => {
            if (!attIdsByDate.has(r.date)) attIdsByDate.set(r.date, new Set());
            attIdsByDate.get(r.date).add(r.studentId);
        });
        schoolDays.forEach(d => {
            const dayAttIds = attIdsByDate.get(d) || new Set();
            const dayLeaveIds = leaveIdsByDate.get(d) || new Set();
            students.forEach(s => {
                if (!dayAttIds.has(s.id) && !dayLeaveIds.has(s.id)) {
                    rows.push([d, s.id, s.name, s.year||'']);
                }
            });
        });
        rows.push([]);
    }

    if (showLeave) {
        rows.push(['=== ประวัติลา ===']);
        rows.push(['ชื่อ','รหัส','ชั้นปี','ประเภทการลา','วันที่ลา','เหตุผล','สถานะ']);
        const statusTh = { pending:'รออนุมัติ', approved:'อนุมัติแล้ว', rejected:'ไม่อนุมัติ' };
        leaveInRange
            .sort((a,b) => b.date.localeCompare(a.date))
            .forEach(r => rows.push([r.name||'', r.studentId||'', r.year||'', r.type||'', r.date, r.reason||'', statusTh[r.status||'pending']]));
        rows.push([]);
    }

    const summaryRow = ['=== สรุป ===', '', '', '', '', '', `นักศึกษา: ${students.length}, วันเรียน: ${schoolDays.length}, สล็อตทั้งหมด: ${totalSlots}`];
    if (rows.length > 0) rows.push([]);
    rows.push(summaryRow);

    const filename = `reports_${start}_${end}.csv`;
    const csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    showToast('📥 Export สำเร็จ!');
}

// STEP 15: Print the reports section. Preserves existing report state — no data
// mutation, no fake data, no new API calls. Uses window.print() on the rendered
// report content only.
function printReport() {
    if (typeof window === 'undefined' || typeof window.print !== 'function') return;
    showToast('🖨️ กำลังเปิดหน้าพิมพ์...');
    const reportSection = document.getElementById('section-reports');
    if (!reportSection) { window.print(); return; }

    const controls = document.querySelector('#section-reports .report-controls');
    const skeletons = reportSection.querySelectorAll('.skeleton');
    const printBtn = document.getElementById('reportPrintBtn');
    const origControlStyle = controls ? controls.style.display : '';
    const origBtnStyle = printBtn ? printBtn.style.display : '';
    if (controls) controls.style.display = 'none';
    if (printBtn) printBtn.style.display = 'none';
    skeletons.forEach(s => { s.style.display = 'none'; });
    const cards = reportSection.querySelectorAll('.dash-card, .table-card, .report-summary-grid');
    cards.forEach(c => { c.style.display = ''; });

    window.print();

    if (controls) controls.style.display = origControlStyle || '';
    if (printBtn) printBtn.style.display = origBtnStyle || '';
    skeletons.forEach(s => { s.style.display = ''; });
}

// ── Backup / Restore ──
function exportBackup() {
    try {
        const data = {
            students: DataStore.getStudents(),
            attendance: DataStore.getAttendance(),
            leaves: DataStore.getLeaves(),
            exportedAt: new Date().toISOString(),
            version: '1.0',
            _meta: {
                totalStudents: DataStore.getStudents().length,
                totalAttendance: DataStore.getAttendance().length,
                totalLeaves: DataStore.getLeaves().length,
                warning: 'ไฟล์นี้มีข้อมูลชีวมิติ (face descriptors) ของนักศึกษา — ควรเก็บรักษาอย่างปลอดภัย'
            }
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `backup_${DateHelper.today()}.json`; a.click();
        URL.revokeObjectURL(url);
        showToast('📦 สำรองข้อมูลสำเร็จ!');
    } catch (e) {
        console.error('exportBackup error:', e);
        showToast('❌ ไม่สามารถสำรองข้อมูลได้');
    }
}
function importBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        if (file.size > 10 * 1024 * 1024) {
            showToast('❌ ไฟล์ใหญ่เกินไป (สูงสุด 10MB)');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                
                if (!data || typeof data !== 'object') {
                    showToast('❌ ไฟล์ข้อมูลไม่ถูกต้อง: ไม่ใช่ JSON object');
                    return;
                }
                if (!Array.isArray(data.students) || !Array.isArray(data.attendance) || !Array.isArray(data.leaves)) {
                    showToast('❌ ไฟล์ข้อมูลไม่ถูกต้อง: ขาด array ที่จำเป็น');
                    return;
                }
                if (typeof data.version !== 'string') {
                    showToast('❌ ไฟล์ข้อมูลไม่ถูกต้อง: ขาด version');
                    return;
                }
                
                const validStudents = data.students.filter(s => DataStore.validateStudent(s));
                const validAttendance = data.attendance.filter(r => DataStore.validateAttendance(r));
                const validLeaves = data.leaves.filter(r => DataStore.validateLeave(r));
                
                if (validStudents.length !== data.students.length) {
                    showToast(`⚠️ พบข้อมูลนักศึกษาที่ไม่ถูกต้อง ${data.students.length - validStudents.length} รายการ จะไม่นำเข้าบางส่วน`);
                }
                if (validAttendance.length !== data.attendance.length) {
                    showToast(`⚠️ พบข้อมูลเข้าแถวที่ไม่ถูกต้อง ${data.attendance.length - validAttendance.length} รายการ จะไม่นำเข้าบางส่วน`);
                }
                if (validLeaves.length !== data.leaves.length) {
                    showToast(`⚠️ พบข้อมูลการลาที่ไม่ถูกต้อง ${data.leaves.length - validLeaves.length} รายการ จะไม่นำเข้าบางส่วน`);
                }
                
                if (validStudents.length === 0 && validAttendance.length === 0 && validLeaves.length === 0) {
                    showToast('❌ ไฟล์ข้อมูลว่างเปล่า');
                    return;
                }
                
                const totalRecords = validStudents.length + validAttendance.length + validLeaves.length;
                const confirmMsg = `⚠️ การนำเข้าข้อมูลจะเขียนทับข้อมูลเดิมทั้งหมด!\n\n` +
                    `นักศึกษา: ${validStudents.length} คน\n` +
                    `รายการเข้าแถว: ${validAttendance.length} รายการ\n` +
                    `รายการลา: ${validLeaves.length} รายการ\n\n` +
                    `ยืนยัน?`;
                
                if (!confirm(confirmMsg)) return;
                if (!confirm('⚠️ ยืนยันอีกครั้ง?\n\nข้อมูลเดิมจะหายไปถาวร!')) return;
                
                const s1 = DataStore.saveStudents(validStudents);
                const s2 = DataStore.saveAttendance(validAttendance);
                const s3 = DataStore.saveLeaves(validLeaves);
                
                if (!s1 || !s2 || !s3) {
                    showToast('❌ ไม่สามารถบันทึกข้อมูลได้ครบถ้วน');
                    return;
                }
                
                registeredFaces = DataStore.getStudents();
                attendanceList = DataStore.getAttendance();
                leaveList = DataStore.getLeaves();
                
                updateStats();
                renderDBTable();
                renderAttendanceTable();
                renderLeaveTable();
                showToast(`📥 นำเข้าข้อมูลสำเร็จ! (${totalRecords} รายการ)`);
            } catch (err) {
                showToast('❌ ไม่สามารถอ่านไฟล์ข้อมูลได้');
                console.error(err);
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

// ── Admin ──
function checkAdminLogin() {
    const u = document.getElementById('adminUser').value.trim();
    const p = document.getElementById('adminPass').value.trim();
    const e = document.getElementById('loginError');
    if (u === CONFIG.ADMIN_CREDENTIALS.user && p === CONFIG.ADMIN_CREDENTIALS.pass) {
        isAdminSession = true;
        adminSessionUser = u;
        document.getElementById('adminUser').value = '';
        document.getElementById('adminPass').value = '';
        if (e) e.style.display = 'none';
        closeModal('loginModal');
        openModal('adminDashboardModal');
    } else {
        if (e) { e.style.display = 'block'; setTimeout(() => e.style.display='none', 3000); }
    }
}
function openAdminWeekly() {
    closeModal('adminDashboardModal');
    document.getElementById('adminDataTitle').textContent = '📅 รายชื่อการเข้าแถวสัปดาห์นี้';
    document.getElementById('adminTableHead').innerHTML = '<tr><th>#</th><th>วันที่</th><th>เวลา</th><th>รหัส</th><th>ชื่อ-นามสกุล</th><th>สถานะ</th><th>ตรวจสอบ</th></tr>';
    const recs = getThisWeekRecords();
    document.getElementById('adminTableBody').innerHTML = recs.length === 0
        ? '<tr><td colspan="7" class="empty-table-cell">ยังไม่มีข้อมูลสัปดาห์นี้</td></tr>'
        : recs.map((r,i) => {
            const late = isLate(r.time);
            const canReview = isAdminSession && r.evidenceId;
            const actionCell = canReview
                ? '<button class="btn-secondary btn-sm" onclick="openAttDetail(' + JSON.stringify(r).replace(/"/g, '&quot;') + ')">ตรวจสอบใบหน้า</button>'
                : '<span style="color:var(--text-muted);">—</span>';
            return `<tr><td style="color:var(--text-muted);font-family:var(--font-mono)">${i+1}</td><td style="font-family:var(--font-mono)">${escapeHtml(r.date)}</td><td style="font-family:var(--font-mono)">${escapeHtml(r.time)}</td><td style="font-family:var(--font-mono)">${escapeHtml(r.studentId||'—')}</td><td>${escapeHtml(r.name)}</td><td><span class="badge ${late?'badge-yellow':'badge-green'}">${late?'มาสาย':'ตรงเวลา'}</span></td><td class="att-actions">${actionCell}</td></tr>`;
        }).join('');
    openModal('adminDataModal');
}
function openAdminStats() {
    closeModal('adminDashboardModal');
    document.getElementById('adminDataTitle').textContent = '📊 สถิติการเข้าแถว 18 สัปดาห์';
    document.getElementById('adminTableHead').innerHTML = '<tr><th>สัปดาห์ที่</th><th>จำนวนเข้าแถว</th><th>นักศึกษาทั้งหมด</th><th>เปอร์เซ็นต์</th><th>สถานะ</th></tr>';
    document.getElementById('adminTableBody').innerHTML = Array.from({length:18}, (_,i) => {
        const cnt   = attendanceList.filter(r => r.weekNum === i+1).length;
        const total = registeredFaces.length || 1;
        const pct   = Math.round(cnt / total * 100);
        const bc    = pct>=80?'badge-green':pct>=60?'badge-yellow':'badge-red';
        const lbl   = pct>=80?'🟢 ดี':pct>=60?'🟡 ปานกลาง':'🔴 น้อย';
        return `<tr><td style="font-family:var(--font-mono)">สัปดาห์ที่ ${i+1}</td><td style="font-family:var(--font-mono)">${cnt}</td><td style="font-family:var(--font-mono)">${registeredFaces.length}</td><td><span class="badge ${bc}">${pct}%</span></td><td>${lbl}</td></tr>`;
    }).join('');
    openModal('adminDataModal');
}
function openAdminAllWeeks() {
    closeModal('adminDashboardModal');
    document.getElementById('weekGrid').innerHTML = Array.from({length:18}, (_,i) => `<button class="week-btn" onclick="viewSpecificWeek(${i+1})">สัปดาห์ ${i+1}</button>`).join('');
    openModal('weekSelectModal');
}
function viewSpecificWeek(w) {
    closeModal('weekSelectModal');
    document.getElementById('adminDataTitle').textContent = `📂 ข้อมูลการเข้าแถว สัปดาห์ที่ ${w}`;
    document.getElementById('adminTableHead').innerHTML = '<tr><th>#</th><th>วันที่</th><th>เวลา</th><th>ชื่อ-นามสกุล</th><th>ชั้นปี</th><th>สถานะ</th><th>ตรวจสอบ</th></tr>';
    const recs = attendanceList.filter(r => r.weekNum === w);
    document.getElementById('adminTableBody').innerHTML = recs.length === 0
        ? `<tr><td colspan="7" class="empty-table-cell">ยังไม่มีข้อมูลสัปดาห์ที่ ${w}</td></tr>`
        : recs.map((r,i) => {
            const late = isLate(r.time);
            const canReview = isAdminSession && r.evidenceId;
            const actionCell = canReview
                ? '<button class="btn-secondary btn-sm" onclick="openAttDetail(' + JSON.stringify(r).replace(/"/g, '&quot;') + ')">ตรวจสอบใบหน้า</button>'
                : '<span style="color:var(--text-muted);">—</span>';
            return `<tr><td style="color:var(--text-muted);font-family:var(--font-mono)">${i+1}</td><td style="font-family:var(--font-mono)">${escapeHtml(r.date)}</td><td style="font-family:var(--font-mono)">${escapeHtml(r.time)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.year||'—')}</td><td><span class="badge ${late?'badge-yellow':'badge-green'}">${late?'มาสาย':'ตรงเวทา'}</span></td><td class="att-actions">${actionCell}</td></tr>`;
        }).join('');
    openModal('adminDataModal');
}
function openAdminLeave() {
    closeModal('adminDashboardModal');
    document.getElementById('adminDataTitle').textContent = '📝 สถิติการลาแต่ละคน';
    document.getElementById('adminTableHead').innerHTML = '<tr><th>รหัส</th><th>ชื่อ-นามสกุล</th><th>ชั้นปี</th><th>ลาทั้งหมด</th><th>ลาป่วย</th><th>ลากิจ</th></tr>';
    // นับจำนวนลาแต่ละคน
    const summary = {};
    leaveList.forEach(r => {
        if (!summary[r.studentId]) summary[r.studentId] = { name:r.name, year:r.year||'—', total:0, sick:0, personal:0 };
        summary[r.studentId].total++;
        if (r.type === 'ลาป่วย')  summary[r.studentId].sick++;
        if (r.type === 'ลากิจ') summary[r.studentId].personal++;
    });
    const rows = Object.entries(summary);
    document.getElementById('adminTableBody').innerHTML = rows.length === 0
        ? '<tr><td colspan="6" class="empty-table-cell">ยังไม่มีข้อมูลการลา</td></tr>'
        : rows.map(([id, d]) => `<tr>
            <td style="font-family:var(--font-mono)">${escapeHtml(id)}</td>
            <td style="font-weight:600">${escapeHtml(d.name)}</td>
            <td>${escapeHtml(d.year)}</td>
            <td><span class="badge ${d.total>=3?'badge-red':d.total>=2?'badge-yellow':'badge-green'}">${d.total} ครั้ง</span></td>
            <td><span class="badge badge-blue">${d.sick} ครั้ง</span></td>
            <td><span class="badge badge-yellow">${d.personal} ครั้ง</span></td>
          </tr>`).join('');
    openModal('adminDataModal');
}

// ── Historical Attendance ──
let histPendingEdit = null;

function getStudentAttendanceStatus(studentId, date) {
    const hasAtt = attendanceList.find(r => r.studentId === studentId && r.date === date);
    if (hasAtt) return { status: DateHelper.isLate(hasAtt.time) ? 'late' : 'present', record: hasAtt };
    const hasLeave = leaveList.find(r => r.studentId === studentId && r.date === date && r.status === 'approved');
    if (hasLeave) return { status: hasLeave.type === 'holiday' ? 'holiday' : 'leave', record: hasLeave };
    return { status: 'absent', record: null };
}

function openAdminHistorical() {
    if (!isAdminSession) {
        showToast('❌ กรุณาเข้าสู่ระบบอาจารย์ก่อน');
        return;
    }
    closeModal('adminDashboardModal');
    const dateEl = document.getElementById('histDate');
    if (dateEl) { dateEl.value = DateHelper.today(); dateEl.max = DateHelper.today(); }
    populateClassFilters();
    const cf = document.getElementById('histClassFilter');
    if (cf) cf.value = 'all';
    openModal('histAttendanceModal');
    setTimeout(loadHistoricalAttendance, 100);
}

function openAdminAuditLog() {
    if (!isAdminSession) {
        showToast('❌ กรุณาเข้าสู่ระบบอาจารย์ก่อน');
        return;
    }
    closeModal('adminDashboardModal');
    populateAuditFilters();
    renderAuditLog();
    document.getElementById('auditLogTitle').textContent = '📋 บันทึกการดำเนินการ';
    openModal('auditLogModal');
}

function populateAuditFilters() {
    const logs = DataStore.getAuditLog();
    const admins = new Set(), actions = new Set(), entities = new Set();
    logs.forEach(e => { if (e.admin) admins.add(e.admin); if (e.action) actions.add(e.action); if (e.entity) entities.add(e.entity); });
    const sel = (id, allLabel, values) => {
        const el = document.getElementById(id);
        if (!el) return;
        let html = `<option value="all">${allLabel}</option>`;
        html += values.map(v => {
            const val = (v && typeof v === 'object') ? v.v : v;
            const label = (v && typeof v === 'object') ? v.label : v;
            return `<option value="${escapeHtml(val)}">${escapeHtml(label)}</option>`;
        }).join('');
        el.innerHTML = html;
    };
    sel('auditAdminFilter', 'ทุกผู้ทำ', [...admins].sort());
    sel('auditActionFilter', 'ทุกประเภท', [...actions].sort().map(a => ({ v: a, label: AUDIT_ACTION_LABEL[a] || a })));
    sel('auditEntityFilter', 'ทุกเอนทิตี', [...entities].sort().map(e => ({ v: e, label: AUDIT_ENTITY_LABEL[e] || e })));
}

function renderAuditLog() {
    const logs = DataStore.getAuditLog();
    const tbody = document.getElementById('auditLogBody');
    if (!tbody) return;

    const d1 = document.getElementById('auditDateFilter')?.value || '';
    const d2 = document.getElementById('auditDateFilter2')?.value || '';
    const aF = document.getElementById('auditAdminFilter')?.value || 'all';
    const actF = document.getElementById('auditActionFilter')?.value || 'all';
    const entF = document.getElementById('auditEntityFilter')?.value || 'all';

    const inRange = (d) => { if (d1 && d < d1) return false; if (d2 && d > d2) return false; return true; };
    const safeLogs = logs.slice().reverse().filter(e => {
        const d = e.date || (e.timestamp ? e.timestamp.slice(0, 10) : '');
        if (!inRange(d)) return false;
        if (aF !== 'all' && (e.admin || '') !== aF) return false;
        if (actF !== 'all' && (e.action || '') !== actF) return false;
        if (entF !== 'all' && (e.entity || '') !== entF) return false;
        return true;
    });

    if (safeLogs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="empty-table-cell">ยังไม่มีบันทึกการดำเนินการ</td></tr>';
        return;
    }
    const statusLabel = (s) => {
        if (s === 'present') return '<span class="badge badge-green">ตรงเวลา</span>';
        if (s === 'late') return '<span class="badge badge-yellow">มาสาย</span>';
        if (s === 'absent') return '<span class="badge badge-red">ขาด</span>';
        if (s === 'leave') return '<span class="badge badge-blue">ลา</span>';
        return `<span class="badge">${escapeHtml(String(s || ''))}</span>`;
    };
    const fmtObj = (o) => {
        if (!o || typeof o !== 'object') return '<span style="color:var(--text-muted)">—</span>';
        const parts = Object.keys(o).map(k => `${escapeHtml(k)}: ${escapeHtml(String(o[k]))}`);
        return parts.length ? parts.join('<br>') : '<span style="color:var(--text-muted)">—</span>';
    };
    tbody.innerHTML = safeLogs.map(entry => {
        const ts = entry.timestamp || '';
        const d = entry.date || ts.slice(0, 10);
        const admin = entry.admin || entry.changedBy || '—';
        const action = AUDIT_ACTION_LABEL[entry.action] || escapeHtml(entry.action || '—');
        const entity = AUDIT_ENTITY_LABEL[entry.entity] || escapeHtml(entry.entity || '—');
        const target = entry.studentId
            ? `<span style="font-family:var(--font-mono)">${escapeHtml(entry.studentId)}</span> ${escapeHtml(entry.studentName||'')}`
            : escapeHtml(entry.studentName || entry.entityId || '—');
        let prevHtml, currHtml;
        if (entry.before) prevHtml = fmtObj(entry.before);
        else if ([ 'present','late','absent','leave' ].includes(entry.previousStatus)) prevHtml = statusLabel(entry.previousStatus);
        else prevHtml = `<span class="badge">${escapeHtml(entry.previousStatus||'')}</span>`;
        if (entry.after) currHtml = fmtObj(entry.after);
        else if ([ 'present','late','absent','leave' ].includes(entry.newStatus)) currHtml = statusLabel(entry.newStatus);
        else currHtml = `<span class="badge">${escapeHtml(entry.newStatus||'')}</span>`;
        return `<tr>
            <td style="font-family:var(--font-mono)">${escapeHtml(d)}</td>
            <td style="font-family:var(--font-mono)">${escapeHtml(admin)}</td>
            <td>${action}</td>
            <td>${entity}</td>
            <td style="font-family:var(--font-mono)">${escapeHtml(entry.entityId||'')}</td>
            <td>${target}</td>
            <td>${prevHtml}</td>
            <td>${currHtml}</td>
            <td>${entry.reason ? escapeHtml(entry.reason) : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td style="font-family:var(--font-mono)">${ts ? new Date(ts).toLocaleString('th-TH') : '—'}</td>
        </tr>`;
    }).join('');
}

// STEP 14: set the date picker to the start of the selected academic week (May-based).
function setWeekDate(weekStr) {
    if (!weekStr) {
        const d = document.getElementById('histDate');
        if (d) d.value = DateHelper.today();
        loadHistoricalAttendance();
        return;
    }
    const weekNum = parseInt(weekStr, 10);
    if (isNaN(weekNum) || weekNum < 1 || weekNum > 14) return;
    var ayEl = document.getElementById('histAcademicYear');
    var ay = ayEl ? ayEl.value : DateHelper.academicYear();
    var may1 = new Date(parseInt(ay, 10), 4, 1);
    may1.setDate(may1.getDate() + (weekNum - 1) * 7);
    var dateStr = may1.getFullYear() + '-' + String(may1.getMonth() + 1).padStart(2, '0') + '-' + String(may1.getDate()).padStart(2, '0');
    var d = document.getElementById('histDate');
    if (d) d.value = dateStr;
    loadHistoricalAttendance();
}

function loadHistoricalAttendance() {
    if (!isAdminSession) return;
    const date = document.getElementById('histDate')?.value || '';
    if (!date) { showToast('❌ กรุณาเลือกวันที่'); return; }
    const classFilter = document.getElementById('histClassFilter')?.value || 'all';
    const tbody = document.getElementById('histAttendanceBody');
    const empty = document.getElementById('histAttendanceEmpty');
    const table = document.getElementById('histAttendanceTable');
    if (!tbody) return;

    let list = registeredFaces;
    if (classFilter !== 'all') list = list.filter(s => (s.year||'—') === classFilter);

    const kindBadge = {
        present: ['badge-green','✓ ตรงเวลา'],
        late:    ['badge-yellow','⏰ มาสาย'],
        absent:  ['badge-red','✕ ขาด'],
        leave:   ['badge-blue','📝 ลา'],
        holiday: ['badge-purple','🎌 วันหยุด']
    };

    tbody.innerHTML = list.length === 0
        ? ''
        : list.map(s => {
            const { status, record } = getStudentAttendanceStatus(s.id, date);
            const [badgeCls, badgeLbl] = kindBadge[status];
            const timeStr = record ? record.time : '—';
            const methodStr = record ? (record.method || 'ใบหน้า (AI)') : '—';
            const avatarInit = escapeHtml((s.name||'?').trim().charAt(0));
            return `<tr class="hist-row" data-student-id="${escapeHtml(s.id)}" data-date="${escapeHtml(date)}">
                <td class="hist-avatar-cell"><div class="student-avatar-sm">${avatarInit}</div></td>
                <td style="font-family:var(--font-mono)">${escapeHtml(s.id)}</td>
                <td style="font-weight:600">${escapeHtml(s.name)}</td>
                <td>${escapeHtml(s.year||'—')}</td>
                <td><span class="badge ${badgeCls}">${badgeLbl}</span></td>
                <td style="font-family:var(--font-mono);font-size:0.82rem">${escapeHtml(timeStr)}</td>
                <td style="font-size:0.78rem;color:var(--text-muted)">${escapeHtml(methodStr)}</td>
                <td>
                     <select class="hist-status-select form-input" style="font-size:0.82rem;padding:5px 8px;">
                         <option value="present" ${status === 'present' ? 'selected' : ''}>✓ ตรงเวลา</option>
                         <option value="late" ${status === 'late' ? 'selected' : ''}>⏰ มาสาย</option>
                         <option value="absent" ${status === 'absent' ? 'selected' : ''}>✕ ขาด</option>
                         <option value="leave" ${status === 'leave' ? 'selected' : ''}>📝 ลา</option>
                         <option value="holiday" ${status === 'holiday' ? 'selected' : ''}>🎌 วันหยุด</option>
                     </select>
                 </td>
                 <td>
                     <textarea class="hist-reason form-input" placeholder="เหตุผล (จำเป็น)" style="font-size:0.78rem;padding:5px 8px;width:120px;height:60px;resize:vertical;" required></textarea>
                 </td>
                <td><button class="btn-danger-sm hist-save-btn" onclick="saveHistStudent(this)" style="font-size:0.75rem;">บันทึก</button></td>
            </tr>`;
        }).join('');

    if (list.length === 0) {
        if (empty) empty.style.display = 'block';
        if (table) table.style.display = 'none';
    } else {
        if (empty) empty.style.display = 'none';
        if (table) table.style.display = '';
    }
}

function saveHistStudent(btn) {
    if (!isAdminSession) { showToast('❌ ไม่ได่รับอนุญาติ'); return; }
    const row = btn.closest('.hist-row');
    if (!row) return;
    const studentId = row.getAttribute('data-student-id');
    const date = row.getAttribute('data-date');
    const student = DataStore.findStudentById(studentId);
    if (!student) return;

    const statusSelect = row.querySelector('.hist-status-select');
    const reasonTextarea = row.querySelector('.hist-reason');
    if (!statusSelect || !reasonTextarea) return;

    const newStatus = statusSelect.value;
    const reason = reasonTextarea.value.trim();

    const { status: currentStatus } = getStudentAttendanceStatus(studentId, date);

    if (newStatus === currentStatus) {
        showToast('⚠️ สถานะเหมือนเดิม ไม่มีการเปลี่ยนแปลง');
        return;
    }

    if (!reason) {
        showToast('❌ กรุณากรอกเหตุผล');
        statusSelect.focus();
        return;
    }

    histPendingEdit = {
        studentId,
        date,
        studentName: student.name,
        previousStatus: currentStatus,
        newStatus,
        reason
    };

    const confirmContent = document.getElementById('histEditConfirmContent');
    if (confirmContent) {
        confirmContent.innerHTML = `
            <div style="text-align:left;font-size:0.85rem;line-height:1.8;">
                <div><span style="color:var(--text-muted)">นักศึกษา:</span> <strong>${escapeHtml(student.name)}</strong> <span style="color:var(--text-muted);font-family:var(--font-mono)">(${escapeHtml(student.id)})</span></div>
                <div><span style="color:var(--text-muted)">วันที่:</span> <strong>${escapeHtml(date)}</strong></div>
                <div><span style="color:var(--text-muted)">สถานะเดิม:</span> <span class="badge ${kindBadgeClass(currentStatus)}">${escapeHtml(statusLabel(currentStatus))}</span></div>
                 <div><span style="color:var(--text-muted)">สถานะใหม่:</span> <span class="badge ${kindBadgeClass(newStatus)}">${escapeHtml(statusLabel(newStatus))}</span></div>
                 <div><span style="color:var(--text-muted)">เหตุผล:</span> <strong>${escapeHtml(reason)}</strong> <span style="color:var(--text-muted);font-size:0.75rem;">(จำเป็น)</span></div>
            </div>
        `;
    }
    openModal('confirmHistEditModal');
}

function statusLabel(s) {
    const labels = { present: 'ตรงเวลา', late: 'มาสาย', absent: 'ขาด', leave: 'ลา', holiday: 'วันหยุด' };
    return labels[s] || s;
}
function kindBadgeClass(s) {
    const cls = { present: 'badge-green', late: 'badge-yellow', absent: 'badge-red', leave: 'badge-blue', holiday: 'badge-purple' };
    return cls[s] || 'badge-green';
}

function cancelHistEdit() {
    histPendingEdit = null;
    closeModal('confirmHistEditModal');
}

// STEP 9: send an attendance correction to the protected admin API.
// Returns a fetch promise; rejects if the API is not configured.
function apiAttendanceCorrection(payload) {
    const cfg = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.ATTENDANCE_API) ? CONFIG.ATTENDANCE_API : null;
    if (!cfg || !cfg.token) return Promise.reject(new Error('attendance API not configured'));
    const url = cfg.url.replace(/\/+$/, '') + '/api/attendance/correction';
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.token },
        body: JSON.stringify(payload),
    });
}
// STEP 12: fetch real audit data from the server-side audit trail (STEP 10).
// Reusable — accepts optional filter params (studentId, date, admin, action).
function apiAuditList(params) {
    const cfg = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.ATTENDANCE_API) ? CONFIG.ATTENDANCE_API : null;
    if (!cfg || !cfg.token) return Promise.reject(new Error('attendance API not configured'));
    const qs = new URLSearchParams();
    qs.set('limit', '200');
    if (params && params.studentId) qs.set('studentId', params.studentId);
    if (params && params.date) qs.set('date', params.date);
    if (params && params.admin) qs.set('admin', params.admin);
    if (params && params.action) qs.set('action', params.action);
    return fetch(cfg.url.replace(/\/+$/, '') + '/api/audit?' + qs.toString(), {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + cfg.token },
    });
}

// STEP 12: Correction History UI — fetches the REAL server-side audit trail (STEP 10).
// Reuses the existing statusLabel/kindBadgeClass/sanitizeAuditObj helpers for safety.
function openAdminCorrectionHistory() {
    if (!isAdminSession) { showToast('❌ กรุณาเข้าสู่ระบบอาจารย์ก่อน'); return; }
    openModal('correctionHistoryModal');
    renderCorrectionHistory();
}

function renderCorrectionHistory() {
    var tbody = document.getElementById('corrHistBody');
    var empty = document.getElementById('corrHistEmpty');
    if (!tbody) return;

    var dateFrom = document.getElementById('corrHistDateFrom') ? document.getElementById('corrHistDateFrom').value : '';
    var dateTo = document.getElementById('corrHistDateTo') ? document.getElementById('corrHistDateTo').value : '';
    var studentFilter = document.getElementById('corrHistStudentFilter') ? document.getElementById('corrHistStudentFilter').value.trim() : '';
    var adminFilter = document.getElementById('corrHistAdminFilter') ? document.getElementById('corrHistAdminFilter').value.trim() : '';

    tbody.innerHTML = '<tr><td colspan="7" class="empty-table-cell">⏳ กำลังโหลด...</td></tr>';
    if (empty) empty.style.display = 'none';
    var table = document.getElementById('corrHistTable');
    if (table) table.style.display = '';

    apiAuditList({ action: 'attendance_correction' })
        .then(function (resp) { return resp.json().catch(function () { return { audit: [] }; }).then(function (d) { return { status: resp.status, body: d }; }); })
        .then(function (res) {
            if (!res.status || res.status !== 200) {
                tbody.innerHTML = '<tr><td colspan="7" class="empty-table-cell">❌ ไม่สามารถโหลดข้อมูลได้</td></tr>';
                return;
            }
            var entries = (res.body && res.body.audit) || [];
            // Client-side filtering (server already filtered by action; date/student/admin are best-effort)
            var filtered = entries.filter(function (e) {
                var d = e.date || (e.timestamp ? e.timestamp.toString().slice(0, 10) : '');
                if (dateFrom && d < dateFrom) return false;
                if (dateTo && d > dateTo) return false;
                if (studentFilter && (e.studentId || '').indexOf(studentFilter) === -1) return false;
                if (adminFilter && (e.changedBy || '').indexOf(adminFilter) === -1) return false;
                return true;
            });

            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="empty-table-cell">ไม่มีประวัติการแก้ไข</td></tr>';
                if (empty) empty.style.display = 'block';
                if (table) table.style.display = 'none';
                return;
            }

            tbody.innerHTML = filtered.map(function (e) {
                var d = e.date || (e.timestamp ? e.timestamp.toString().slice(0, 10) : '—');
                var studentDisplay = e.studentId
                    ? '<span style="font-family:var(--font-mono)">' + escapeHtml(e.studentId) + '</span> ' + escapeHtml(e.studentName || '')
                    : '<span style="color:var(--text-muted)">—</span>';
                var badgeCls = { present: 'badge-green', late: 'badge-yellow', absent: 'badge-red', leave: 'badge-blue' };
                var lbl = { present: 'ตรงเวลา', late: 'มาสาย', absent: 'ขาด', leave: 'ลา' };
                var prev = e.previousStatus ? '<span class="badge ' + (badgeCls[e.previousStatus] || '') + '">' + escapeHtml(lbl[e.previousStatus] || e.previousStatus) + '</span>' : '<span style="color:var(--text-muted)">—</span>';
                var curr = e.newStatus ? '<span class="badge ' + (badgeCls[e.newStatus] || '') + '">' + escapeHtml(lbl[e.newStatus] || e.newStatus) + '</span>' : '<span style="color:var(--text-muted)">—</span>';
                var reason = e.reason ? escapeHtml(e.reason) : '<span style="color:var(--text-muted)">—</span>';
                var admin = e.changedBy || '—';
                var tsFmt = e.timestamp ? new Date(e.timestamp).toLocaleString('th-TH') : '—';
                return '<tr>' +
                    '<td style="font-family:var(--font-mono);font-size:0.82rem">' + escapeHtml(d) + '</td>' +
                    '<td>' + studentDisplay + '</td>' +
                    '<td>' + prev + '</td>' +
                    '<td>' + curr + '</td>' +
                    '<td>' + reason + '</td>' +
                    '<td style="font-family:var(--font-mono);font-size:0.82rem">' + escapeHtml(admin) + '</td>' +
                    '<td style="font-family:var(--font-mono);font-size:0.78rem;color:var(--text-muted)">' + tsFmt + '</td>' +
                '</tr>';
            }).join('');
        })
        .catch(function (err) {
            console.error('[admin] correction history load failed:', err);
            tbody.innerHTML = '<tr><td colspan="7" class="empty-table-cell">❌ เกิดข้อผิดพลาด</td></tr>';
        });
}

// STEP 10: server-side aggregation of historical statistics. The server returns
// only aggregated counts + small trend/distribution arrays — never the raw
// attendance database — so the browser never downloads the whole DB to compute stats.
function apiStats(filters) {
    const cfg = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.ATTENDANCE_API) ? CONFIG.ATTENDANCE_API : null;
    if (!cfg || !cfg.token) return Promise.reject(new Error('attendance API not configured'));
    const params = new URLSearchParams();
    if (filters.days) params.set('days', String(filters.days));
    if (filters.date) params.set('date', filters.date);
    if (filters.start) params.set('start', filters.start);
    if (filters.end) params.set('end', filters.end);
    if (filters.academicYear) params.set('academicYear', filters.academicYear);
    if (filters.semester) params.set('semester', String(filters.semester));
    if (filters.week) params.set('week', String(filters.week));
    if (filters.className) params.set('className', filters.className);
    if (filters.studentId) params.set('studentId', filters.studentId);
    const url = cfg.url.replace(/\/+$/, '') + '/api/stats?' + params.toString();
    return fetch(url, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + cfg.token },
    }).then(function (resp) {
        if (resp.status === 401) throw new Error('unauthorized');
        if (!resp.ok) throw new Error('stats failed: ' + resp.status);
        return resp.json();
    });
}
// STEP 14: fetch attendance records from the server for a selected week/class.
function apiAttendanceList(params) {
    var cfg = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.ATTENDANCE_API) ? CONFIG.ATTENDANCE_API : null;
    if (!cfg || !cfg.token) return Promise.reject(new Error('attendance API not configured'));
    var qs = new URLSearchParams();
    if (params.date) qs.set('date', params.date);
    if (params.studentId) qs.set('studentId', params.studentId);
    if (params.week) qs.set('week', String(params.week));
    if (params.className) qs.set('className', params.className);
    if (params.academicYear) qs.set('academicYear', params.academicYear);
    if (params.semester) qs.set('semester', String(params.semester));
    qs.set('limit', String(params.limit || 200));
    return fetch(cfg.url.replace(/\/+$/, '') + '/api/attendance?' + qs.toString(), {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + cfg.token },
    }).then(function (resp) {
        if (resp.status === 401) throw new Error('unauthorized');
        if (!resp.ok) throw new Error('attendance list failed: ' + resp.status);
        return resp.json();
    });
}

// ── Class Management API wrappers (STEP 6) ──
// Reuse the ATTENDANCE_API config (same server, same token) from STEP 9.
function classApiBase() {
    if (typeof CONFIG === 'undefined' || !CONFIG || !CONFIG.ATTENDANCE_API || !CONFIG.ATTENDANCE_API.token) return null;
    return { url: CONFIG.ATTENDANCE_API.url.replace(/\/+$/, ''), token: CONFIG.ATTENDANCE_API.token };
}
function classHeaders(extra) {
    const cfg = classApiBase();
    if (!cfg) return null;
    return Object.assign({ 'Authorization': 'Bearer ' + cfg.token }, extra || {});
}
function apiListClasses(code) {
    const cfg = classApiBase();
    if (!cfg) return Promise.reject(new Error('class API not configured'));
    var params = new URLSearchParams();
    if (code) params.set('code', code);
    var qs = params.toString() ? '?' + params.toString() : '';
    return fetch(cfg.url + '/api/classes' + qs, { method: 'GET', headers: classHeaders() })
        .then(function (r) { if (r.status === 401) throw new Error('unauthorized'); if (!r.ok) throw new Error('list classes failed: ' + r.status); return r.json(); });
}
function apiCreateClass(data) {
    const cfg = classApiBase();
    if (!cfg) return Promise.reject(new Error('class API not configured'));
    return fetch(cfg.url + '/api/classes', { method: 'POST', headers: classHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(data) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, body: d }; }); });
}
function apiUpdateClass(classId, data) {
    const cfg = classApiBase();
    if (!cfg) return Promise.reject(new Error('class API not configured'));
    return fetch(cfg.url + '/api/classes/' + encodeURIComponent(classId), { method: 'PUT', headers: classHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(data) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, body: d }; }); });
}
function apiDeleteClass(classId) {
    const cfg = classApiBase();
    if (!cfg) return Promise.reject(new Error('class API not configured'));
    return fetch(cfg.url + '/api/classes/' + encodeURIComponent(classId), { method: 'DELETE', headers: classHeaders() })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, body: d }; }); });
}
function apiListClassStudents(classId) {
    const cfg = classApiBase();
    if (!cfg) return Promise.reject(new Error('class API not configured'));
    return fetch(cfg.url + '/api/classes/' + encodeURIComponent(classId) + '/students', { method: 'GET', headers: classHeaders() })
        .then(function (r) { if (r.status === 401) throw new Error('unauthorized'); if (!r.ok) throw new Error('list students failed: ' + r.status); return r.json(); });
}
function apiAssignStudentToClass(classId, studentId, studentName) {
    const cfg = classApiBase();
    if (!cfg) return Promise.reject(new Error('class API not configured'));
    return fetch(cfg.url + '/api/classes/' + encodeURIComponent(classId) + '/students', { method: 'POST', headers: classHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ studentId: studentId, studentName: studentName }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, body: d }; }); });
}
function apiUnassignStudentFromClass(classId, studentId) {
    const cfg = classApiBase();
    if (!cfg) return Promise.reject(new Error('class API not configured'));
    return fetch(cfg.url + '/api/classes/' + encodeURIComponent(classId) + '/students/' + encodeURIComponent(studentId), { method: 'DELETE', headers: classHeaders() })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, body: d }; }); });
}

// ── Class Management UI (STEP 6) ──
var classServerData = [];
var currentClassViewId = null;

function openAdminClasses() {
    if (!isAdminSession) { showToast('❌ กรุณาเข้าสู่ระบบอาจารย์ก่อน'); return; }
    openModal('adminClassModal');
    refreshClassList();
}
function refreshClassList() {
    var tbody = document.getElementById('classListBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="empty-table-cell">กำลังโหลด...</td></tr>';
    apiListClasses().then(function (data) {
        classServerData = data.classes || [];
        renderClassList(classServerData);
    }).catch(function (e) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-table-cell">เกิดข้อผิดพลาด: ' + escapeHtml(e.message) + '</td></tr>';
    });
}
function renderClassList(classes) {
    var tbody = document.getElementById('classListBody');
    if (!tbody) return;
    if (classes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-table-cell">ยังไม่มีชั้น — ใช้ฟอร์มด้านล่างเพิ่มชั้นแรก</td></tr>';
        return;
    }
    tbody.innerHTML = classes.map(function (c) {
        return '<tr>'
            + '<td style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-muted)">' + escapeHtml(c.classId) + '</td>'
            + '<td>' + escapeHtml(c.code) + '</td>'
            + '<td>' + escapeHtml(c.name) + '</td>'
            + '<td style="text-align:center">' + c.studentCount + '</td>'
            + '<td><button class="btn-sm btn-secondary" onclick="viewClassStudents(' + "'" + c.classId + "'" + ')">👥</button> '
            + '<button class="btn-sm btn-secondary" onclick="editClass(' + "'" + c.classId + "'" + ',' + "'" + escapeHtmlAttr(c.code) + "'" + ',' + "'" + escapeHtmlAttr(c.name) + "'" + ')">✎</button> '
            + '<button class="btn-sm btn-del" onclick="deleteClass(' + "'" + c.classId + "'" + ',' + "'" + escapeHtmlAttr(c.code) + "'" + ',' + "'" + escapeHtmlAttr(c.name) + "'" + ')">✕</button></td>'
            + '</tr>';
    }).join('');
}
function viewClassStudents(classId) {
    currentClassViewId = classId;
    var cls = classServerData.find(function (c) { return c.classId === classId; });
    if (!cls) return;
    document.getElementById('classStudentTitle').textContent = cls.code + ' — นักศึกษา';
    document.getElementById('classStudentCode').textContent = cls.code;
    document.getElementById('classStudentName').textContent = cls.name;
    refreshClassStudentList(classId);
    openModal('classStudentModal');
}
function refreshClassStudentList(classId) {
    var body = document.getElementById('classStudentListBody');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="4" class="empty-table-cell">กำลังโหลด...</td></tr>';
    apiListClassStudents(classId).then(function (data) {
        var students = data.students || [];
        if (students.length === 0) {
            body.innerHTML = '<tr><td colspan="4" class="empty-table-cell">ยังไม่มีนักศึกษาถูกจัดสรรให้ชั้นนี้</td></tr>';
            return;
        }
        body.innerHTML = students.map(function (s) {
            return '<tr>'
                + '<td style="font-family:var(--font-mono)">' + escapeHtml(s.studentId) + '</td>'
                + '<td>' + escapeHtml(s.studentName || s.studentId) + '</td>'
                + '<td style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-muted)">' + DateHelper.toThaiDate(new Date(s.assignedAt)) + '</td>'
                + '<td><button class="btn-del btn-sm" onclick="unassignStudentFromClass(' + "'" + classId + "'" + ',' + "'" + escapeHtmlAttr(s.studentId) + "'" + ')">ถอด</button></td>'
                + '</tr>';
        }).join('');
    }).catch(function (e) {
        body.innerHTML = '<tr><td colspan="4" class="empty-table-cell">เกิดข้อผิดพลาๆ: ' + escapeHtml(e.message) + '</td></tr>';
    });
}
function unassignStudentFromClass(classId, studentId) {
    if (!confirm('ยืนยันถอดนักศึกษา ' + studentId + ' ออกจากชั้น?')) return;
    apiUnassignStudentFromClass(classId, studentId).then(function (r) {
        if (r.status === 200) { refreshClassStudentList(classId); refreshClassList(); showToast('✓ ถอดนักศึกษาแล้ว'); }
        else showToast('❌ ' + (r.body && r.body.error || 'ไม่สามารถถอดได้'));
    });
}
function assignStudentToCurrentClass() {
    var classId = currentClassViewId;
    if (!classId) return;
    var studentId = (document.getElementById('assignStudentId')?.value || '').trim();
    var studentName = (document.getElementById('assignStudentName')?.value || '').trim();
    if (!studentId) { showToast('❌ ใส่รหัสนักศึกษา'); return; }
    apiAssignStudentToClass(classId, studentId, studentName).then(function (r) {
        if (r.status === 201) {
            document.getElementById('assignStudentId').value = '';
            document.getElementById('assignStudentName').value = '';
            refreshClassStudentList(classId);
            refreshClassList();
            showToast('✓ จัดสรรนักศึกษาแล้ว');
        } else showToast('❌ ' + (r.body && r.body.error || 'ไม่สามารถจัดสรรได้'));
    });
}
function openCreateClass() {
    document.getElementById('classEditId').value = '';
    document.getElementById('classCode').value = '';
    document.getElementById('className').value = '';
    document.getElementById('classFormTitle').textContent = 'เพิ่มชั้นใหม่';
    openModal('classFormModal');
}
function editClass(classId, code, name) {
    document.getElementById('classEditId').value = classId;
    document.getElementById('classCode').value = code;
    document.getElementById('className').value = name;
    document.getElementById('classFormTitle').textContent = 'แก้ไขชั้น ' + code;
    openModal('classFormModal');
}
function deleteClass(classId, code, name) {
    if (!confirm('⚠️ ลบชั้น ' + code + '?\nนักศึกษาจะไม่ถูกลบ แต่การจัดสรรอาจถูกล้าง')) return;
    apiDeleteClass(classId).then(function (r) {
        if (r.status === 200) { refreshClassList(); showToast('🗑️ ลบชั้นแล้ว'); }
        else showToast('❌ ' + (r.body && r.body.error || 'ไม่สามารถลบได้'));
    });
}
function submitClassForm() {
    var classId = document.getElementById('classEditId').value;
    var code = (document.getElementById('classCode').value || '').trim();
    var name = (document.getElementById('className').value || '').trim();
    if (!code || !name) { showToast('❌ ใส่รหัสและชื่อชั้น'); return; }
    var data = { code: code, name: name, admin: currentAdmin() };
    var promise = classId ? apiUpdateClass(classId, data) : apiCreateClass(data);
    promise.then(function (r) {
        if (r.status === 200 || r.status === 201) {
            refreshClassList();
            closeModal('classFormModal');
            showToast(classId ? '✓ อัปเดตชั้นแล้ว' : '✓ เพิ่มชั้นใหม่แล้ว');
        } else showToast('❌ ' + (r.body && r.body.error || 'เกิดข้อผิดพลาด'));
    });
}
// escapeHtmlAttr for inline onclick attribute values
function escapeHtmlAttr(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ── Server sync: attendance (STEP 9 correction endpoint doubles as the create/
// upsert path — the server derives previousStatus itself, so a scan simply
// reports the new status and the server creates the row if none exists yet,
// or updates the existing one in place if it does. This is what makes a live
// face-scan and a later backdated/manual correction land in the SAME row
// (keyed by studentId+date) instead of two disconnected records.) ──
function apiSyncAttendance(data) {
    const cfg = classApiBase();
    if (!cfg) return Promise.reject(new Error('attendance API not configured'));
    return fetch(cfg.url + '/api/attendance/correction', {
        method: 'POST',
        headers: classHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(data),
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, body: d }; }); });
}
// Called right after DataStore.addAttendance() so a face-scan check-in is
// mirrored to Supabase, not just kept in the browser's localStorage.
// Best-effort: never blocks or breaks the local check-in UI if offline/unconfigured.
function syncScanAttendance(record) {
    if (!record || !record.studentId || !record.date) return;
    const newStatus = (record.time && record.time > '08:00') ? 'late' : 'present';
    apiSyncAttendance({
        studentId: record.studentId,
        date: record.date,
        newStatus: newStatus,
        method: 'FACE_RECOGNITION',
        admin: currentAdmin(),
        className: record.year || '',
        week: record.weekNum || undefined,
    }).catch(function (e) { console.warn('[attendance-sync] failed (kept locally only):', e); });
}

// ── Server sync: registered students (face descriptors) — mirrors a new
// registration to Supabase so it is not lost on browser reset and is visible
// from any device running this app against the same backend. ──
function apiSyncStudent(student) {
    const cfg = classApiBase();
    if (!cfg) return Promise.reject(new Error('attendance API not configured'));
    return fetch(cfg.url + '/api/students', {
        method: 'POST',
        headers: classHeaders({ 'Content-Type': 'application/json' }),
        // 'samples' (the raw 200-shot capture set) is intentionally NOT sent —
        // only the compact recognition templates are needed server-side.
        body: JSON.stringify({ id: student.id, name: student.name, year: student.year, descriptors: student.descriptors }),
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, body: d }; }); });
}
function syncStudentRegistration(student) {
    apiSyncStudent(student).catch(function (e) { console.warn('[student-sync] failed (kept locally only):', e); });
}
// Pulls the server's student list and merges any students that exist on the
// server but not yet in this browser's localStorage (e.g. registered from a
// different device). Local-only students are pushed up by syncStudentRegistration
// at registration time, so this direction completes the round trip.
function hydrateStudentsFromServer() {
    const cfg = classApiBase();
    if (!cfg) return Promise.resolve();
    return fetch(cfg.url + '/api/students', { method: 'GET', headers: classHeaders() })
        .then(function (r) { if (!r.ok) throw new Error('list students failed: ' + r.status); return r.json(); })
        .then(function (d) {
            const serverStudents = (d && Array.isArray(d.students)) ? d.students : [];
            if (!serverStudents.length) return;
            const local = DataStore.getStudents();
            const localIds = new Set(local.map(function (s) { return s.id; }));
            let added = 0;
            serverStudents.forEach(function (s) {
                if (!localIds.has(s.id) && DataStore.validateStudent(s)) {
                    local.push(s);
                    added++;
                }
            });
            if (added > 0) {
                DataStore.saveStudents(local);
                registeredFaces = DataStore.getStudents();
                if (typeof updateStats === 'function') updateStats();
            }
        })
        .catch(function (e) { console.warn('[student-sync] hydrate failed:', e); });
}

// ── Scan History API wrappers (STEP 7) ──
function apiLogScan(data) {
    var cfg = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.ATTENDANCE_API) ? CONFIG.ATTENDANCE_API : null;
    if (!cfg || !cfg.token) return Promise.reject(new Error('class API not configured'));
    var _tApi = PM && PM.isEnabled() ? PM.now() : 0;
    return fetch(cfg.url.replace(/\/+$/, '') + '/api/scans/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.token },
        body: JSON.stringify(data),
    }).then(function (r) {
        var d = r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, body: d }; });
        if (PM && PM.isEnabled() && _tApi) { PM.set('apiMs', PM.now() - _tApi); }
        return d;
    });
}
function apiGetScans(opts) {
    var cfg = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.ATTENDANCE_API) ? CONFIG.ATTENDANCE_API : null;
    if (!cfg || !cfg.token) return Promise.reject(new Error('class API not configured'));
    var params = new URLSearchParams();
    if (opts && opts.limit) params.set('limit', String(opts.limit));
    if (opts && opts.date) params.set('date', opts.date);
    if (opts && opts.result) params.set('result', opts.result);
    if (opts && opts.className) params.set('className', opts.className);
    var qs = params.toString() ? '?' + params.toString() : '';
    return fetch(cfg.url.replace(/\/+$/, '') + '/api/scans' + qs, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + cfg.token },
    }).then(function (r) { if (r.status === 401) throw new Error('unauthorized'); if (!r.ok) throw new Error('scans failed: ' + r.status); return r.json(); });
}

// ── Scan History helper (called from scan.js) ──
// result: 'recognized' | 'unknown' | 'duplicate' | 'failed'
// attendanceStatus: 'present' | 'duplicate' | null
// evidenceRef: evidenceId string or null
function logScanEvent(studentId, studentName, year, result, attendanceStatus, evidenceRef, confidence, error) {
    if (!isAdminSession) return; // only log when admin session is active
    var data = {
        studentId: studentId || null,
        studentName: studentName || null,
        class: year || null,
        result: result,
        attendanceStatus: attendanceStatus || null,
        evidenceRef: evidenceRef || null,
        confidence: confidence || null,
        scanTime: Date.now(),
        admin: currentAdmin(),
    };
    if (error) data.error = error;
    apiLogScan(data).catch(function (e) { console.warn('[scan-history] log failed:', e); });
}

// ── Scan History UI (STEP 7) ──
function openAdminScanHistory() {
    if (!isAdminSession) { showToast('❌ กรุณาเข้าสู่ระบบอาจารย์ก่อน'); return; }
    openModal('adminScanHistoryModal');
    refreshScanHistory();
}
function filterScanHistory() {
    var result = document.getElementById('scanResultFilter')?.value || 'all';
    var date = document.getElementById('scanDateFilter')?.value || '';
    var body = document.getElementById('scanHistoryBody');
    if (!body || !classServerData) { refreshScanHistory(); return; }
    body.innerHTML = '<tr><td colspan="7" class="empty-table-cell">กำลังโหลด...</td></tr>';
    var opts = { limit: 100 };
    if (result !== 'all') opts.result = result;
    if (date) opts.date = date;
    apiGetScans(opts).then(function (data) {
        var scans = data.scans || [];
        var badge = document.getElementById('scanHistoryCount');
        if (badge) badge.textContent = data.total + ' รายการ';
        if (scans.length === 0) {
            body.innerHTML = '<tr><td colspan="7" class="empty-table-cell">ไม่พบผลลัพธ์ตามตัวกรอง</td></tr>';
            return;
        }
        body.innerHTML = scans.map(function (s) {
            var resultLabel = scanResultLabel(s.result);
            var statusLabel = scanStatusLabel(s.attendanceStatus);
            var evidenceLabel = s.evidenceRef ? '<span style="color:var(--teal)">มี</span>' : '<span style="color:var(--text-muted)">ไม่มี</span>';
            var confLabel = s.confidence != null ? s.confidence + '%' : '—';
            return '<tr>'
                + '<td>' + escapeHtml(s.studentName || '—') + '</td>'
                + '<td style="font-family:var(--font-mono)">' + escapeHtml(s.studentId || '—') + '</td>'
                + '<td>' + escapeHtml(s.class || '—') + '</td>'
                + '<td style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-muted)">' + DateHelper.toThaiTime(new Date(s.scanTime)) + '</td>'
                + '<td>' + resultLabel + '</td>'
                + '<td>' + statusLabel + '</td>'
                + '<td>' + confLabel + ' ' + evidenceLabel + '</td>'
                + '</tr>';
        }).join('');
    }).catch(function (e) {
        body.innerHTML = '<tr><td colspan="7" class="empty-table-cell">เกิดข้อผิดพลาๆ: ' + escapeHtml(e.message) + '</td></tr>';
    });
}

function refreshScanHistory() {
    var body = document.getElementById('scanHistoryBody');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="7" class="empty-table-cell">กำลังโหลด...</td></tr>';
    apiGetScans({ limit: 100 }).then(function (data) {
        var scans = data.scans || [];
        var badge = document.getElementById('scanHistoryCount');
        if (badge) badge.textContent = data.total + ' รายการ';
        if (scans.length === 0) {
            body.innerHTML = '<tr><td colspan="7" class="empty-table-cell">ยังไม่มีประวัติการสแกน</td></tr>';
            return;
        }
        body.innerHTML = scans.map(function (s) {
            var resultLabel = scanResultLabel(s.result);
            var statusLabel = scanStatusLabel(s.attendanceStatus);
            var evidenceLabel = s.evidenceRef ? '<span style="color:var(--teal)">มี</span>' : '<span style="color:var(--text-muted)">ไม่มี</span>';
            var confLabel = s.confidence != null ? s.confidence + '%' : '—';
            return '<tr>'
                + '<td>' + escapeHtml(s.studentName || '—') + '</td>'
                + '<td style="font-family:var(--font-mono)">' + escapeHtml(s.studentId || '—') + '</td>'
                + '<td>' + escapeHtml(s.class || '—') + '</td>'
                + '<td style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-muted)">' + DateHelper.toThaiTime(new Date(s.scanTime)) + '</td>'
                + '<td>' + resultLabel + '</td>'
                + '<td>' + statusLabel + '</td>'
                + '<td>' + confLabel + ' ' + evidenceLabel + '</td>'
                + '</tr>';
        }).join('');
    }).catch(function (e) {
        body.innerHTML = '<tr><td colspan="7" class="empty-table-cell">เกิดข้อผิดพลาๆ: ' + escapeHtml(e.message) + '</td></tr>';
    });
}

function scanResultLabel(result) {
    var labels = { recognized: '✅ จับคู่ได้', unknown: '❌ ไม่จับคู่', duplicate: '⚠️ ซ้ำ', failed: '❌ ผิดพลาด' };
    return labels[result] || escapeHtml(result);
}
function scanStatusLabel(status) {
    if (status === 'present') return '<span style="color:var(--teal)">เข้าแถวแล้ว</span>';
    if (status === 'duplicate') return '<span style="color:var(--yellow)">ซ้ำ</span>';
    return '<span style="color:var(--text-muted)">—</span>';
}

// ── System Health (STEP 8) ──
function systemHealthApiBase() {
    if (typeof CONFIG === 'undefined' || !CONFIG || !CONFIG.ATTENDANCE_API || !CONFIG.ATTENDANCE_API.token) return null;
    return { url: CONFIG.ATTENDANCE_API.url.replace(/\/+$/, ''), token: CONFIG.ATTENDANCE_API.token };
}
function evidenceHealthUrl() {
    if (typeof CONFIG === 'undefined' || !CONFIG || !CONFIG.EVIDENCE_STORAGE || !CONFIG.EVIDENCE_STORAGE.url) return null;
    return CONFIG.EVIDENCE_STORAGE.url.replace(/\/+$/, '') + '/health';
}

// Check API health: attendance-service /health (no auth required)
function checkApiHealth() {
    var cfg = systemHealthApiBase();
    if (!cfg) return Promise.resolve({ ok: false, error: 'API not configured' });
    return fetch(cfg.url + '/health', { method: 'GET' })
        .then(function (r) {
            if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
            return r.json().then(function (d) { return { ok: true, data: d }; });
        })
        .catch(function (e) { return { ok: false, error: e.message || 'connection failed' }; });
}

// Check evidence storage health: storage-service /health (no auth required)
function checkEvidenceHealth() {
    var url = evidenceHealthUrl();
    if (!url) return Promise.resolve({ ok: false, error: 'not configured' });
    return fetch(url, { method: 'GET' })
        .then(function (r) {
            if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
            return r.json().then(function (d) { return { ok: true, data: d }; });
        })
        .catch(function (e) { return { ok: false, error: e.message || 'connection failed' }; });
}

// Check face recognition model status (client-side)
function checkFaceModelHealth() {
    if (typeof faceapi === 'undefined') return { ok: false, error: 'face-api not loaded' };
    if (faceModelStatus === 'error') return { ok: false, error: 'model load failed' };
    if (faceModelStatus === 'loading') return { ok: false, error: 'loading' };
    // Verify networks are actually loaded
    try {
        var hasNet = faceapi.nets.ssdMobilenetv1 && faceapi.nets.ssdMobilenetv1.params;
        if (!hasNet) return { ok: false, error: 'models not initialized' };
        return { ok: true, error: null };
    } catch (e) {
        return { ok: false, error: 'check error: ' + e.message };
    }
}

// Check database / local storage health (client-side)
function checkDatabaseHealth() {
    if (!isAdminSession) return { ok: false, error: 'admin session required' };
    var counts = {
        students: typeof DataStore !== 'undefined' ? DataStore.getStudents().length : 0,
        attendance: typeof DataStore !== 'undefined' ? DataStore.getAttendance().length : 0,
        leaves: typeof DataStore !== 'undefined' ? DataStore.getLeaves().length : 0,
        classes: typeof DataStore !== 'undefined' ? DataStore.getClasses().length : 0,
        evidence: typeof DataStore !== 'undefined' ? (DataStore.getEvidence ? DataStore.getEvidence().length : 0) : 0,
        rosters: typeof DataStore !== 'undefined' ? DataStore.getRosters().length : 0,
    };
    return { ok: true, counts: counts };
}

function openAdminSystemHealth() {
    if (!isAdminSession) { showToast('❌ กรุณาเข้าสู่ระบบอาจารย์ก่อน'); return; }
    openModal('adminHealthModal');
    refreshSystemHealth();
}

function refreshSystemHealth() {
    // Reset UI to "checking" state
    setHealthRow('api', '⏳', 'กำลังตรวจสอบ...');
    setHealthRow('evidence', '⏳', 'กรุณารอ...');
    setHealthRow('faceModel', '⏳', 'กำลังตรวจสอบ...');
    setHealthRow('database', '⏳', 'กำลังตรวจสอบ...');

    // API health (async)
    checkApiHealth().then(function (result) {
        if (result.ok) {
            var d = result.data;
            setHealthRow('api', '✅', 'เชื่อมต่อแล้ว (' + (d.service || 'ok') + ')');
            var detail = '';
            if (d.counts) {
                detail = 'เข้าแถว=' + d.counts.attendance + ' ชั้น=' + d.counts.classes + ' สแกน=' + d.counts.scanLogs + ' ระบบ=' + d.counts.audit;
            }
            document.getElementById('healthApiDetail').textContent = detail;
        } else {
            setHealthRow('api', '❌', result.error || 'เชื่อมต่อไม่ได้');
            document.getElementById('healthApiDetail').textContent = '';
        }
    });

    // Evidence storage health (async)
    checkEvidenceHealth().then(function (result) {
        if (result.ok) {
            setHealthRow('evidence', '✅', 'พร้อมใช้งาน');
        } else {
            setHealthRow('evidence', '❌', result.ok === false ? (result.error || 'ไม่พร้อม') : 'ไม่ได้ตั้งค่า');
        }
    });

    // Face model health (sync)
    var fm = checkFaceModelHealth();
    setHealthRow('faceModel', fm.ok ? '✅' : '❌', fm.ok ? 'โมเดลโหลดแล้ว' : (fm.error || 'ข้อผิดพลาด'));

    // Database / local storage health (sync)
    var db = checkDatabaseHealth();
    if (db.ok) {
        setHealthRow('database', '✅', 'พร้อมใช้งาน');
        var detail = '';
        var c = db.counts;
        detail = 'นักศึกษา=' + c.students + ' เข้าแถว=' + c.attendance + ' ชั้น=' + c.classes + ' หลักฐาน=' + c.evidence + ' โรงเรียน=' + c.rosters;
        document.getElementById('healthDbDetail').textContent = detail;
    } else {
        setHealthRow('database', '❌', db.error || 'ข้อผิดพลาด');
        document.getElementById('healthDbDetail').textContent = '';
    }
}

function setHealthRow(id, icon, status) {
    var el = document.getElementById('health' + id.charAt(0).toUpperCase() + id.slice(1) + 'Status');
    if (el) el.textContent = icon + ' ' + status;
}

// STEP 6: Class Management UI (STEP 6)
var classServerData = [];
var currentClassViewId = null;
// the browser's roster collection (STEP 8) — this is NOT a download of the
// attendance database, just local membership scoping.
function reportRosterFilters() {
    const sel = (id) => document.getElementById(id);
    const val = (el) => (el && el.value && el.value !== 'all') ? el.value : null;
    const ay  = val(sel('reportYearFilter'));
    const sem = val(sel('reportSemesterFilter'));
    const wk  = val(sel('reportWeekFilter'));
    const cls = val(sel('reportClassFilter'));
    const stu = val(sel('reportStudentFilter'));
    return { academicYear: ay, semester: sem ? Number(sem) : null, week: wk ? Number(wk) : null, classFilter: cls ? cls : 'all', studentFilter: stu ? stu : 'all' };
}
function scopedRosterStudents(ay, sem, week, classF, studentF) {
    let base = registeredFaces.slice();
    if (ay || sem || week || (classF && classF !== 'all')) {
        const q = {};
        if (ay) q.academicYear = ay;
        if (sem) q.semester = sem;
        if (week) q.week = week;
        if (classF && classF !== 'all') q.className = classF;
        const rows = DataStore.findRosters(q);
        const ids = rows.length ? new Set(rows.map(r => r.studentId)) : null;
        base = ids ? base.filter(s => ids.has(s.id)) : base;
    }
    if (classF && classF !== 'all') base = base.filter(s => (s.year || '—') === classF);
    if (studentF && studentF !== 'all') base = base.filter(s => s.id === studentF);
    return base;
}
function populateReportRosterFilters() {
    const now = new Date();
    const curAy = DateHelper.academicYear(now);
    const years = DateHelper.academicYearOptions();
    const ySel = document.getElementById('reportYearFilter');
    if (ySel) {
        ySel.innerHTML = '<option value="all">ทุกปีการศึกษา</option>' + years.map(y => `<option value="${y}">${parseInt(y,10)+543} (ระบบ คศ.${y})</option>`).join('');
        ySel.value = curAy;
    }
    const semSel = document.getElementById('reportSemesterFilter');
    if (semSel) {
        semSel.innerHTML = '<option value="all">ทุกภาค</option><option value="1">ภาค 1 (พ.ค.–ตุลา)</option><option value="2">ภาค 2 (พย.–เมษายน)</option>';
        semSel.value = String(DateHelper.academicSemester(now));
    }
    const wSel = document.getElementById('reportWeekFilter');
    if (wSel) {
        const options = ['<option value="all">ทุกสัปดาห์</option>'];
        for (let i = 1; i <= CONFIG.ROSTER_WEEK_MAX; i++) options.push(`<option value="${i}">สัปดาห์ที่ ${i}</option>`);
        wSel.innerHTML = options.join('');
        wSel.value = String(Math.min(DateHelper.getAcademicWeekNum(now) || 1, CONFIG.ROSTER_WEEK_MAX));
    }
}

// Sync the browser cache from the server-confirmed result (the authoritative write
// already happened server-side; this only mirrors it locally for live UI continuity).
function syncCorrectionToCache(ed, resp) {
    const att = resp && resp.attendance;
    const lvs = resp && resp.leave;
    if (att) {
        const i = attendanceList.findIndex(r => r.studentId === att.studentId && r.date === att.date);
        if (i !== -1) attendanceList[i] = att; else attendanceList.push(att);
    } else {
        // absent/leave/removed: clear any stale attendance for this student+date
        const i = attendanceList.findIndex(r => r.studentId === ed.studentId && r.date === ed.date);
        if (i !== -1) attendanceList.splice(i, 1);
    }
    if (lvs) {
        const i = leaveList.findIndex(l => l.studentId === lvs.studentId && l.date === lvs.date && l.status === 'approved');
        if (i !== -1) leaveList[i] = lvs; else leaveList.push(lvs);
    }
    DataStore.saveAttendance(attendanceList);
    DataStore.saveLeaves(leaveList);
}
function confirmHistEditSave() {
    if (!isAdminSession) { showToast('❌ ไม่ได้รับอนุญาติ'); closeModal('confirmHistEditModal'); return; }
    if (!histPendingEdit) return;

    const saveBtn = document.getElementById('histEditConfirmSave');
    if (saveBtn) saveBtn.disabled = true;

    const ed = histPendingEdit;
    const student = DataStore.findStudentById(ed.studentId);
    if (!student) { if (saveBtn) saveBtn.disabled = false; return; }

    // STEP 9: do NOT directly mutate the database from the frontend. Submit the
    // correction to the protected API — the server validates + applies + persists it.
    const scope = DateHelper.academicContext(ed.date);
    const payload = {
        studentId: ed.studentId,
        date: ed.date,
        newStatus: ed.newStatus,
        previousStatus: ed.previousStatus,
        reason: ed.reason,
        method: 'แก้ไขย้อนหลัง (AI)',   // reuse existing method convention (manual admin edit)
        admin: adminSessionUser || 'admin',
        academicYear: scope.academicYear,
        semester: scope.semester,
        week: scope.week,
        className: student.year || '',
    };

    showToast('⏳ กำลังบันทึกการแก้ไข...');
    apiAttendanceCorrection(payload)
        .then(function (resp) {
            return resp.json().catch(function () { return {}; }).then(function (data) {
                return { status: resp.status, body: data };
            });
        })
        .then(function (res) {
            if (!res.status || res.status === 401) {
                showToast('❌ ไม่ได้รับอนุญาติ — การแก้ไขล้มเหลว');
            } else if (res.status === 409) {
                // STEP 9: optimistic concurrency conflict — the record was modified by another admin.
                var serverStatus = (res.body && res.body.previousStatus) || 'unknown';
                showToast('⚠️ บันทึกไม่สำเร็จ: สถานะเปลี่ยนแล้ว (ปัจจุบัน: ' + statusLabel(serverStatus) + ') กรุณารีเฟรชและลองอีกครั้ง');
            } else if (res.status !== 200) {
                showToast('❌ บันทึกไม่สำเร็จ: ' + ((res.body && res.body.error) || ('รหัส ' + res.status)));
            } else {
                // Server confirmed: mirror the authoritative result into the live cache
                // and append to the EXISTING client-side audit architecture.
                syncCorrectionToCache(ed, res.body);
                auditLog('attendance_correction', 'attendance', ed.recordId || ed.studentId + '_' + ed.date, {
                    studentId: ed.studentId, studentName: ed.studentName, date: ed.date,
                    reason: ed.reason, admin: adminSessionUser || 'admin',
                    before: { status: ed.previousStatus }, after: { status: ed.newStatus },
                    previousStatus: ed.previousStatus, newStatus: ed.newStatus, serverConfirmed: true,
                    recordId: (res.body && res.body.recordId) || ed.recordId || null,
                });
                showToast('✅ บันทึกการเปลี่ยนแปลงแล้ว');
            }
        })
        .catch(function (err) {
            console.error('[admin] attendance correction failed:', err);
            showToast('❌ ไม่สามารถบันทึกการแก้ไขได้ (เซิร์ฟเวอร์ตอบกลับผิดพลาด)');
        })
        .finally(function () {
            histPendingEdit = null;
            const saveBtn = document.getElementById('histEditConfirmSave');
            if (saveBtn) saveBtn.disabled = false;
            closeModal('confirmHistEditModal');
            loadHistoricalAttendance();
        });
}

// ── Helpers ──
function getThisWeekRecords() {
    const now = new Date();
    const day = now.getDay();
    const mon = new Date(now); mon.setDate(now.getDate() - (day===0?6:day-1)); mon.setHours(0,0,0,0);
    const sun = new Date(mon); sun.setDate(mon.getDate()+6); sun.setHours(23,59,59,999);
    return attendanceList.filter(r => {
        const d = r.timestamp ? new Date(r.timestamp) : new Date(r.date + 'T00:00:00');
        return !isNaN(d.getTime()) && d >= mon && d <= sun;
    });
}
function getAcademicWeekNum(date) {
    if (!date) date = new Date();
    const start = new Date(date.getFullYear(), 4, 1);
    return DateHelper.getAcademicWeekNum(date);
}

// ══════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════
let dashTrendRange = 7;
function setTrendRange(days) {
    dashTrendRange = days;
    document.getElementById('trendTab7')?.classList.toggle('active', days === 7);
    document.getElementById('trendTab30')?.classList.toggle('active', days === 30);
    document.getElementById('trendTab90')?.classList.toggle('active', days === 90);
    renderDashboard();
}

function renderDashboard() {
    const dl = document.getElementById('dashDateLine');
    if (dl) dl.textContent = DateHelper.toThaiDateLong();

    const today = DateHelper.today();
    const todayAtt = attendanceList.filter(r => r.date === today);
    const presentOnTime = todayAtt.filter(r => !DateHelper.isLate(r.time)).length;
    const late = todayAtt.filter(r => DateHelper.isLate(r.time)).length;
    const total = registeredFaces.length;
    const leaveToday = leaveList.filter(r => r.date === today && r.status === 'approved').length;
    const presentIds = new Set(todayAtt.map(r => r.studentId));
    const leaveIds = new Set(leaveList.filter(r => r.date === today && r.status === 'approved').map(r => r.studentId));
    const absent = registeredFaces.filter(s => !presentIds.has(s.id) && !leaveIds.has(s.id)).length;

    setText('kpiTotal', total);
    setText('kpiPresent', presentOnTime);
    setText('kpiLate', late);
    setText('kpiAbsent', absent);
    setText('kpiLeave', leaveToday);

    const attended = presentOnTime + late;
    const rate = total > 0 ? Math.round((attended / total) * 100) : 0;
    const rateEl = document.getElementById('dashRate');
    if (rateEl) rateEl.textContent = `${rate}%`;
    const progressBar = document.getElementById('dashRateBar');
    if (progressBar) progressBar.style.width = `${rate}%`;
    const totalEl = document.getElementById('dashTotalStudents');
    if (totalEl) totalEl.textContent = total;

    renderTrendChart('trendChart', dashTrendRange);
    renderRecentList();
    renderClassCompare('classCompareBody');
    renderAttentionList();
    renderStatusDistribution(presentOnTime, late, absent, leaveToday, total, 'statusDistributionBody');
    renderSystemStatus();
}
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

// สร้างข้อมูลแนวโน้ม N วันล่สุดจากข้อมูลจริงใน attendanceList/leaveList (ไม่มี mock data)
// รับ startDate เป็นตัวเลือกเพื่รกำหนดช่วงวันที่เองในรายงาน
// รับ studentIds เป็นตัวเลือกเพื่อกรองเฉพาะกลุ่มนักศึกษาที่เลือกในรายงาน
function buildTrendData(days, startDate, studentIds) {
    const out = [];
    const base = startDate ? true : false;
    const total = studentIds ? studentIds.size : registeredFaces.length;
    for (let i = 0; i < days; i++) {
        const d = base ? new Date(startDate + 'T00:00:00') : new Date();
        if (base) d.setDate(d.getDate() + i); else d.setDate(d.getDate() - (days - 1 - i));
        const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
        const dateStr = `${y}-${m}-${day}`;
        const recs = studentIds
            ? attendanceList.filter(r => r.date === dateStr && studentIds.has(r.studentId))
            : attendanceList.filter(r => r.date === dateStr);
        const present = recs.filter(r => !DateHelper.isLate(r.time)).length;
        const lateN   = recs.filter(r => DateHelper.isLate(r.time)).length;
        const leaveRecs = studentIds
            ? leaveList.filter(r => r.date === dateStr && r.status === 'approved' && studentIds.has(r.studentId))
            : leaveList.filter(r => r.date === dateStr && r.status === 'approved');
        const leaveN  = leaveRecs.length;
        const absentN = Math.max(0, total - present - lateN - leaveN);
        out.push({ date: dateStr, label: d.toLocaleDateString('th-TH', { day:'numeric', month:'short' }), present, late: lateN, leave: leaveN, absent: absentN });
    }
    return out;
}
function renderTrendChart(elId, days, dataOverride) {
    const el = document.getElementById(elId);
    if (!el) return;
    const data = dataOverride || buildTrendData(days);
    const maxTotal = Math.max(1, ...data.map(d => d.present + d.late + d.leave + d.absent));
    el.innerHTML = data.map(d => {
        const totalDay = d.present + d.late + d.leave + d.absent;
        const scale = totalDay > 0 ? (totalDay / maxTotal) * 100 : 0;
        const segs = [
            d.present ? `<div class="trend-bar-seg present" style="height:${(d.present/Math.max(1,totalDay))*100}%" title="ตรงเวลา ${d.present}"></div>` : '',
            d.late    ? `<div class="trend-bar-seg late"    style="height:${(d.late/Math.max(1,totalDay))*100}%"    title="มาสาย ${d.late}"></div>`    : '',
            d.leave   ? `<div class="trend-bar-seg leaveseg" style="height:${(d.leave/Math.max(1,totalDay))*100}%"  title="ลา ${d.leave}"></div>`      : '',
            d.absent  ? `<div class="trend-bar-seg absent"  style="height:${(d.absent/Math.max(1,totalDay))*100}%" title="ขาด ${d.absent}"></div>`     : '',
        ].join('');
        return `<div class="trend-bar-wrap">
            <div class="trend-bar-stack" style="height:${Math.max(4,scale)}%">${segs}</div>
            <div class="trend-label">${escapeHtml(d.label)}</div>
        </div>`;
    }).join('') || '<div class="dash-empty">ยังไม่มีข้อมูล</div>';
}

// Status Distribution chart — uses real values computed by renderReports()
function renderStatusDistribution(present, late, absent, leave, totalSlots, elId = 'reportStatusDist') {
    const el = document.getElementById(elId);
    if (!el) return;
    if (totalSlots === 0) {
        el.innerHTML = '<p class="dash-empty">ยังไม่มีข้อมูล</p>';
        return;
    }
    const bar = (val, total, colorVar, label) => {
        const p = total > 0 ? Math.round(val / total * 100) : 0;
        return `<div class="report-status-bar-wrap">
            <div class="report-status-bar-label" style="color:${colorVar}">${label}</div>
            <div class="report-status-bar-track">
                <div class="report-status-bar-fill" style="width:${p}%;background:${colorVar};">${val} (${p}%)</div>
            </div>
        </div>`;
    };
    el.innerHTML = `
        <div class="report-status-legend">
            ${bar(present, totalSlots, 'var(--green)', 'ตรงเวลา')}
            ${bar(late, totalSlots, 'var(--yellow)', 'มาสาย')}
            ${bar(absent, totalSlots, 'var(--red)', 'ขาด')}
            ${bar(leave, totalSlots, 'var(--blue)', 'ลา')}
        </div>
    `;
}

// Late/Absence Trend chart — bar chart showing daily late + absent counts
function renderLateAbsenceTrend(trendData) {
    const el = document.getElementById('reportLateAbsenceTrend');
    if (!el) return;
    const maxLate = Math.max(1, ...trendData.map(d => d.late + d.absent));
    if (trendData.length === 0 || trendData.every(d => d.late === 0 && d.absent === 0)) {
        el.innerHTML = '<p class="dash-empty">ไม่มีข้อมูลมาสายหรือขาดในช่วงเลือก</p>';
        return;
    }
    el.innerHTML = trendData.map(d => {
        const total = d.late + d.absent;
        const latePct = total > 0 ? (d.late / total) * 100 : 0;
        const absPct = total > 0 ? (d.absent / total) * 100 : 0;
        const segs = [
            d.late   ? `<div class="trend-bar-seg late"   style="height:${latePct}%" title="มาสาย ${d.late}"></div>` : '',
            d.absent ? `<div class="trend-bar-seg absent" style="height:${absPct}%" title="ขาด ${d.absent}"></div>` : '',
        ].join('');
        const scale = (total / maxLate) * 100;
        return `<div class="trend-bar-wrap">
            <div class="trend-bar-stack" style="height:${Math.max(4, scale)}%">${segs}</div>
            <div class="trend-label">${escapeHtml(d.label)}</div>
        </div>`;
    }).join('');
}

function renderRecentList() {
    const el = document.getElementById('recentList');
    if (!el) return;
    const recent = attendanceList.slice().sort((a,b) => (b.timestamp||0)-(a.timestamp||0)).slice(0, 8);
    el.innerHTML = recent.length === 0
        ? '<p class="dash-empty">ยังไม่มีข้อมูลการเข้าแถว</p>'
        : recent.map(r => {
            const late = DateHelper.isLate(r.time);
            const initial = escapeHtml((r.name||'?').trim().charAt(0));
            return `<div class="recent-row">
                <div class="recent-avatar">${initial}</div>
                <div class="recent-info"><div class="recent-name">${escapeHtml(r.name)}</div><div class="recent-sub">${escapeHtml(r.studentId||'—')} • ${escapeHtml(r.date)}</div></div>
                <span class="badge ${late?'badge-yellow':'badge-green'}">${escapeHtml(r.time)}</span>
            </div>`;
    }).join('');
    var badge = document.getElementById('classCountBadge');
    if (badge) badge.textContent = classes.length + ' ชั้น';
}

// เปรียบเทียบเปอร์เซ็นต์เข้าแถว "วันนี้" ตามชั้นปี — ใช้ elId เดียวกันได้ทั้งแดชบอร์ดและรายงาน
function renderClassCompare(elId, dateFilter, classFilter) {
    const el = document.getElementById(elId);
    if (!el) return;
    const date = dateFilter || DateHelper.today();
    const classes = getClassList(classFilter);
    if (classes.length === 0) { el.innerHTML = '<p class="dash-empty">ยังไม่มีข้อมูลนักศึกษา</p>'; return; }
    el.innerHTML = classes.map(c => {
        const inClass = registeredFaces.filter(s => (s.year||'—') === c);
        const ids = new Set(inClass.map(s => s.id));
        let presentCount, totalCount;
        if (dateFilter && dateFilter.end) {
            // Date range mode: count attendance records within the range
            presentCount = attendanceList.filter(r => r.date >= dateFilter.start && r.date <= dateFilter.end && ids.has(r.studentId)).length;
            const schoolDays = Array.from(new Set(attendanceList.filter(r => r.date >= dateFilter.start && r.date <= dateFilter.end).map(r => r.date)));
            totalCount = schoolDays.length;
        } else {
            presentCount = attendanceList.filter(r => r.date === date && ids.has(r.studentId)).length;
            totalCount = 1;
        }
        const pct = totalCount > 0 ? Math.round(presentCount / (inClass.length * totalCount) * 100) : 0;
        return `<div class="class-compare-row">
            <div class="class-compare-name">${escapeHtml(c)}</div>
            <div class="class-compare-bar-track"><div class="class-compare-bar-fill" style="width:${pct}%"></div></div>
            <div class="class-compare-pct">${pct}%</div>
        </div>`;
    }).join('');
}

// นักศึกษาที่ควรดูแลเป็นพิเศษ — จัดอันดับจากจำนวนครั้งมาสายใน 30 วันล่าสุด (ข้อมูลจริงเท่านั้น)
function renderAttentionList() {
    const el = document.getElementById('attentionList');
    if (!el) return;
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    const recent = attendanceList.filter(r => { const d = new Date(r.timestamp||r.date); return !isNaN(d) && d >= cutoff; });
    const lateCounts = {};
    recent.forEach(r => { if (DateHelper.isLate(r.time)) lateCounts[r.studentId] = (lateCounts[r.studentId]||0) + 1; });
    const ranked = Object.entries(lateCounts).filter(([,c]) => c >= 2).sort((a,b) => b[1]-a[1]).slice(0, 6);
    if (ranked.length === 0) { el.innerHTML = '<p class="dash-empty">ยังไม่มีนักศึกษาที่มาสายซ้ำในช่วง 30 วันล่าสุด</p>'; return; }
    el.innerHTML = ranked.map(([id, count]) => {
        const s = DataStore.findStudentById(id);
        return `<div class="attention-row">
            <div class="recent-avatar" style="background:var(--yellow-dim);color:var(--yellow);">${escapeHtml((s?.name||'?').charAt(0))}</div>
            <div class="recent-info"><div class="recent-name">${escapeHtml(s?.name||id)}</div><div class="recent-sub">${escapeHtml(id)} • ${escapeHtml(s?.year||'—')}</div></div>
            <span class="attention-badge">${count} ครั้ง</span>
        </div>`;
    }).join('');
}

/* ── Dashboard system status ── */
function renderSystemStatus() {
    const el = document.getElementById('systemStatusBody');
    if (!el) return;
    const studentCount = registeredFaces.length;
    const faceRegCount = registeredFaces.filter(s => (s.descriptors?.length||0) >= CONFIG.FACE_TEMPLATE_COUNT).length;
    const today = DateHelper.today();
    const todayAtt = attendanceList.filter(r => r.date === today).length;
    const cameraOk = typeof cameraActive !== 'undefined' && cameraActive;
    const modelLoaded = typeof faceapi !== 'undefined' && !!faceapi;

    el.innerHTML = `<div class="system-status">
        <div class="system-status-item">
            <span class="system-status-dot ${modelLoaded ? 'online' : 'offline'}"></span>
            <span class="system-status-label">โมเดล AIFace</span>
            <span class="system-status-value">${modelLoaded ? 'โหลดแล้ว' : 'ยังไม่โหลด'}</span>
        </div>
        <div class="system-status-item">
            <span class="system-status-dot ${cameraOk ? 'online' : 'offline'}"></span>
            <span class="system-status-label">กล้ำยเวียดีโอ</span>
            <span class="system-status-value">${cameraOk ? 'พร้อมใช้งาน' : 'ไม่ได้เชื่อมต่อ'}</span>
        </div>
        <div class="system-status-item">
            <span class="system-status-dot ${studentCount > 0 ? 'online' : 'offline'}"></span>
            <span class="system-status-label">ฐานข้อมูลนักศึกษา</span>
            <span class="system-status-value">${studentCount} คน (${faceRegCount} มีใบหน้า)</span>
        </div>
        <div class="system-status-item">
            <span class="system-status-dot ${faceRegCount >= studentCount * 0.5 ? 'online' : 'offline'}"></span>
            <span class="system-status-label">การเช็กชื่อวันนี้</span>
            <span class="system-status-value">${todayAtt}/${studentCount} ราย</span>
        </div>
    </div>`;
}

// ══════════════════════════════════════════════
// REPORTS
// ══════════════════════════════════════════════
function syncDateRangeFromPeriod() {
    const period = document.getElementById('reportPeriod')?.value || 'daily';
    const rangeEl = document.querySelector('.report-date-range');
    if (!rangeEl) return;
    if (period === 'custom') {
        rangeEl.style.display = 'flex';
        const s = document.getElementById('reportStartDate');
        const e = document.getElementById('reportEndDate');
        if (s && !s.value) {
            const d = new Date(); d.setDate(d.getDate() - 6);
            s.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        }
        if (e && !e.value) e.value = DateHelper.today();
    } else {
        rangeEl.style.display = 'none';
    }
}
function reportDateRange() {
    const period = document.getElementById('reportPeriod')?.value || 'daily';
    const end = DateHelper.today();
    let startD, days;
    if (period === 'custom') {
        const s = document.getElementById('reportStartDate')?.value;
        const e = document.getElementById('reportEndDate')?.value;
        if (s && e) {
            startD = new Date(s + 'T00:00:00');
            const endD = new Date(e + 'T00:00:00');
            days = Math.max(1, Math.round((endD - startD) / (24*60*60*1000)) + 1);
            const sStr = `${startD.getFullYear()}-${String(startD.getMonth()+1).padStart(2,'0')}-${String(startD.getDate()).padStart(2,'0')}`;
            const eStr = `${endD.getFullYear()}-${String(endD.getMonth()+1).padStart(2,'0')}-${String(endD.getDate()).padStart(2,'0')}`;
            return { start: sStr, end: eStr, days };
        }
        startD = new Date(); startD.setDate(startD.getDate() - 6);
        days = 7;
    } else {
        days = period === 'monthly' ? 30 : period === 'weekly' ? 7 : 1;
        startD = new Date(); startD.setDate(startD.getDate() - (days - 1));
    }
    const start = `${startD.getFullYear()}-${String(startD.getMonth()+1).padStart(2,'0')}-${String(startD.getDate()).padStart(2,'0')}`;
    return { start, end, days };
}
function renderReports() {
    const { start, end, days } = reportDateRange();
    const { academicYear: ay, semester: sem, week: wk, classFilter: classF, studentFilter: studentF } = reportRosterFilters();

    // STEP 10: Roster denominator ("Total roster"). This is the historical roster
    // membership (STEP 8) held locally — NOT a download of the attendance DB.
    const students = scopedRosterStudents(ay, sem, wk, classF, studentF);
    const studentIds = new Set(students.map(s => s.id));
    const singleDate = days === 1 ? start : null;

    // Real data is used in both paths; the server path performs the aggregation
    // server-side (no full-DB download) and is preferred when the admin API is
    // available. The local path is a real-data fallback for offline/unconfigured use.
    const serverAvail = !!(CONFIG && CONFIG.ATTENDANCE_API && CONFIG.ATTENDANCE_API.token && isAdminSession);

    if (serverAvail) {
        apiStats({ start, end, date: singleDate, academicYear: ay, semester: sem, week: wk,
                     className: classF === 'all' ? null : classF, studentId: studentF === 'all' ? null : studentF })
            .then(function (stats) { renderReportsFromStats(stats, students, studentIds, start, end, days, classF); })
            .catch(function () { renderReportsLocal(students, studentIds, start, end, days, classF); });
        return;
    }
    renderReportsLocal(students, studentIds, start, end, days, classF);
}

function renderReportsFromStats(stats, students, studentIds, start, end, days, classF) {
    const sc = students.length;
    const present = stats.counts.present;
    const late = stats.counts.late;
    const leaveN = stats.counts.leave;

    // School days = dates the server actually saw activity in range; fall back to local if none.
    const sdates = stats.byDate.map(d => d.date);
    const schoolDays = sdates.length
        ? sdates
        : Array.from(new Set(attendanceList.filter(r => r.date >= start && r.date <= end).map(r => r.date)));

    // Trend rows from server aggregates; absent derived from the real roster size per day.
    const trendData = schoolDays.map(d => {
        const row = stats.byDate.find(r => r.date === d) || { date: d, present: 0, late: 0, leave: 0 };
        const p = row.present || 0, l = row.late || 0, lv = row.leave || 0;
        const ab = Math.max(0, sc - p - l - lv);
        return { date: d, label: DateHelper.toThaiDate(new Date(d + 'T00:00:00')), present: p, late: l, leave: lv, absent: ab };
    });
    const absent = trendData.reduce((a, r) => a + r.absent, 0);

    finishReportRender(students, present, late, absent, leaveN, trendData, schoolDays, stats.byClass, classF, start, end);
}

function renderReportsLocal(students, studentIds, start, end, days, classF) {
    const attInRange   = attendanceList.filter(r => r.date >= start && r.date <= end && studentIds.has(r.studentId));
    const leaveInRange = leaveList.filter(r => r.date >= start && r.date <= end && r.status === 'approved' && studentIds.has(r.studentId));

    const present = attInRange.filter(r => !DateHelper.isLate(r.time)).length;
    const late    = attInRange.filter(r => DateHelper.isLate(r.time)).length;
    const leaveN  = leaveInRange.length;
    const schoolDays = Array.from(new Set(attendanceList.filter(r => r.date >= start && r.date <= end).map(r => r.date)));
    let absent = 0;
    students.forEach(s => {
        schoolDays.forEach(d => {
            const hasAtt   = attInRange.some(r => r.studentId === s.id && r.date === d);
            const hasLeave = leaveInRange.some(r => r.studentId === s.id && r.date === d);
            if (!hasAtt && !hasLeave) absent++;
        });
    });
    const trendData = buildTrendData(days, start, studentIds);
    finishReportRender(students, present, late, absent, leaveN, trendData, schoolDays, null, classF, start, end);
}

function finishReportRender(students, present, late, absent, leaveN, trendData, schoolDays, byClass, classF, start, end) {
    const totalSlots = students.length * schoolDays.length;
    const pct        = totalSlots > 0 ? Math.round((present + late) / totalSlots * 100) : 0;
    const lateRate   = totalSlots > 0 ? Math.round(late / totalSlots * 100) : 0;
    const absentRate = totalSlots > 0 ? Math.round(absent / totalSlots * 100) : 0;
    const leaveRate  = totalSlots > 0 ? Math.round(leaveN / totalSlots * 100) : 0;

    const grid = document.getElementById('reportSummaryGrid');
    if (grid) grid.innerHTML = `
        <div class="report-mini-card"><div class="report-mini-num report-student-count">${students.length}</div><div class="report-mini-label">นักศึกษาทั้งหมด</div></div>
        <div class="report-mini-card"><div class="report-mini-num report-present-count">${present}</div><div class="report-mini-label">ตรงเวลา</div></div>
        <div class="report-mini-card"><div class="report-mini-num report-late-count">${late}</div><div class="report-mini-label">มาสาย</div></div>
        <div class="report-mini-card"><div class="report-mini-num report-absent-count">${absent}</div><div class="report-mini-label">ขาด</div></div>
        <div class="report-mini-card"><div class="report-mini-num report-leave-count">${leaveN}</div><div class="report-mini-label">ลา</div></div>
        <div class="report-mini-card"><div class="report-mini-num report-rate-count">${pct}%</div><div class="report-mini-label">อัตราเข้าแถว</div></div>
        <div class="report-mini-card"><div class="report-mini-num report-late-rate">${lateRate}%</div><div class="report-mini-label">อัตรามาสาย</div></div>
        <div class="report-mini-card"><div class="report-mini-num report-absent-rate">${absentRate}%</div><div class="report-mini-label">อัตราขาด</div></div>
        <div class="report-mini-card"><div class="report-mini-num report-leave-rate">${leaveRate}%</div><div class="report-mini-label">อัตราลา</div></div>`;

    renderTrendChart('reportTrendChart', schoolDays.length, trendData);
    if (byClass && Object.keys(byClass).length) {
        renderClassCompareStats(byClass, students, schoolDays);
    } else {
        renderClassCompare('reportClassCompare', { start: start, end: end }, classF);
    }
    renderStatusDistribution(present, late, absent, leaveN, totalSlots);
    renderLateAbsenceTrend(trendData);

    // มาสายบ่อย / ขาดบ่อย ในช่วงที่เลือก (real local mirror; per-student absences need roster-per-day)
    const attInRange   = attendanceList.filter(r => r.date >= start && r.date <= end && studentIds.has(r.studentId));
    const leaveInRange = leaveList.filter(r => r.date >= start && r.date <= end && r.status === 'approved' && studentIds.has(r.studentId));
    const lateCounts = {}, absentCounts = {};
    students.forEach(s => {
        lateCounts[s.id]    = attInRange.filter(r => r.studentId === s.id && DateHelper.isLate(r.time)).length;
        absentCounts[s.id]  = schoolDays.filter(d => !attInRange.some(r => r.studentId === s.id && r.date === d) && !leaveInRange.some(r => r.studentId === s.id && r.date === d)).length;
    });

    const statusFilter = document.getElementById('reportStatusFilter')?.value || 'all';
    const showLate   = (statusFilter === 'all' || statusFilter === 'late');
    const showAbsent = (statusFilter === 'all' || statusFilter === 'absent');

    const lateSection = document.querySelector('#reportLateBody').closest('.table-card');
    if (lateSection) lateSection.style.display = showLate ? '' : 'none';
    document.querySelectorAll('.report-section-title').forEach(t => { if (t.textContent === 'มาสายบ่อย') t.style.display = showLate ? '' : 'none'; });

    const absentSection = document.querySelector('#reportAbsentBody').closest('.table-card');
    if (absentSection) absentSection.style.display = showAbsent ? '' : 'none';
    document.querySelectorAll('.report-section-title').forEach(t => { if (t.textContent === 'ขาดบ่อย') t.style.display = showAbsent ? '' : 'none'; });

    const lateBody = document.getElementById('reportLateBody');
    if (lateBody) {
        const rows = students.map(s => ({ s, c: lateCounts[s.id] })).filter(x => x.c > 0).sort((a,b) => b.c - a.c).slice(0, 10);
        lateBody.innerHTML = rows.length === 0 ? '<tr><td colspan="4" class="empty-table-cell">ไม่มีข้อมูล</td></tr>'
            : rows.map(({s,c}) => `<tr><td style="font-family:var(--font-mono)">${escapeHtml(s.id)}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.year||'—')}</td><td><span class="badge badge-yellow">${c} ครั้ง</span></td></tr>`).join('');
    }
    const absentBody = document.getElementById('reportAbsentBody');
    if (absentBody) {
        const rows = students.map(s => ({ s, c: absentCounts[s.id] })).filter(x => x.c > 0).sort((a,b) => b.c - a.c).slice(0, 10);
        absentBody.innerHTML = rows.length === 0 ? '<tr><td colspan="4" class="empty-table-cell">ไม่มีข้อมูล</td></tr>'
            : rows.map(({s,c}) => `<tr><td style="font-family:var(--font-mono)">${escapeHtml(s.id)}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.year||'—')}</td><td><span class="badge badge-red">${c} ครั้ง</span></td></tr>`).join('');
    }

    const reportEmpty = document.getElementById('reportEmpty');
    if (reportEmpty) reportEmpty.style.display = registeredFaces.length === 0 ? 'flex' : 'none';
}

// STEP 10: class comparison rendered from server-aggregated byClass (real counts)
// combined with the local roster class sizes for the denominator. Reuses existing CSS.
function renderClassCompareStats(byClass, students, schoolDays) {
    const el = document.getElementById('reportClassCompare');
    if (!el) return;
    const classSizes = {};
    students.forEach(s => { const c = s.year || '—'; classSizes[c] = (classSizes[c] || 0) + 1; });
    const slots = schoolDays.length;
    const rows = Object.keys(byClass).map(c => {
        const bc = byClass[c] || { present: 0, late: 0, leave: 0 };
        const attended = (bc.present || 0) + (bc.late || 0);
        const total = (classSizes[c] || 0) * slots;
        const pct = total > 0 ? Math.round(attended / total * 100) : 0;
        return `<div class="class-compare-row">
            <div class="class-compare-name">${escapeHtml(c)}</div>
            <div class="class-compare-bar-track"><div class="class-compare-bar-fill" style="width:${pct}%"></div></div>
            <div class="class-compare-pct">${pct}%</div>
        </div>`;
    });
    el.innerHTML = rows.length ? rows.join('') : '<p class="dash-empty">ไม่มีข้อมูล</p>';
}


// ══════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════
function loadUserSettings() {
    const s = DataStore.getSettings();
    setVal('setStartTime', CONFIG.ATTENDANCE_START_TIME);
    setVal('setLateTime',  CONFIG.LATE_TIME);
    setVal('setEndTime',   CONFIG.ATTENDANCE_END_TIME);
    setVal('setThreshold', CONFIG.FACE_MATCH_THRESHOLD);
    setVal('setMinConf',   CONFIG.FACE_DETECT_MIN_CONFIDENCE);
    setVal('setTemplateCount', CONFIG.FACE_TEMPLATE_COUNT);
    setVal('setConfirmFrames', CONFIG.FACE_CONFIRM_FRAMES);
    setVal('setOrgName',   s.orgName || '');
    setText('setThresholdVal', CONFIG.FACE_MATCH_THRESHOLD);
    setText('setMinConfVal', CONFIG.FACE_DETECT_MIN_CONFIDENCE);
    setText('setConfirmFramesVal', CONFIG.FACE_CONFIRM_FRAMES);
}
function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function saveAttendanceSettings() {
    const start = document.getElementById('setStartTime').value;
    const late  = document.getElementById('setLateTime').value;
    const end   = document.getElementById('setEndTime').value;
    if (!start || !late || !end) { showToast('⚠️ กรุณากรอกเวลาให้ครบ'); return; }
    CONFIG.ATTENDANCE_START_TIME = start;
    CONFIG.LATE_TIME = late;
    CONFIG.ATTENDANCE_END_TIME = end;
    const s = DataStore.getSettings();
    s.attendanceStartTime = start; s.lateTime = late; s.attendanceEndTime = end;
    DataStore.saveSettings(s);
    showToast('💾 บันทึกช่วงเวลาเช็กชื่อแล้ว');
    renderDashboard();
}
function saveFaceSettings() {
    const th = parseFloat(document.getElementById('setThreshold').value);
    const mc = parseFloat(document.getElementById('setMinConf').value);
    const tc = parseInt(document.getElementById('setTemplateCount').value, 10) || CONFIG.FACE_TEMPLATE_COUNT;
    const cf = parseInt(document.getElementById('setConfirmFrames').value, 10) || CONFIG.FACE_CONFIRM_FRAMES;
    CONFIG.FACE_MATCH_THRESHOLD = th;
    CONFIG.FACE_DETECT_MIN_CONFIDENCE = mc;
    CONFIG.FACE_TEMPLATE_COUNT = tc;
    CONFIG.FACE_CONFIRM_FRAMES = cf;
    const s = DataStore.getSettings();
    s.faceMatchThreshold = th; s.faceMinConfidence = mc; s.faceTemplateCount = tc; s.faceConfirmFrames = cf;
    DataStore.saveSettings(s);
    showToast('💾 บันทึกการตั้งค่าการจดจำใบหน้าแล้ว (มีผลตั้งแต่การสแกนครั้งถัดไป)');
}
function saveOrgSettings() {
    const name = document.getElementById('setOrgName').value.trim();
    const s = DataStore.getSettings();
    s.orgName = name;
    DataStore.saveSettings(s);
    showToast('💾 บันทึกข้อมูลสถาบันแล้ว');
}

// ── PWA Update Lifecycle (STEP 3 / STEP 8) ──
// The <script> block in index.html dispatches 'pwa-update-available' when a new
// Service Worker has installed with fresh assets. We notify the user via toast;
// the SW auto-activates (skipWaiting) and triggers a reload via controllerchange.
// No app data (localStorage) is touched — only static shell assets are refreshed.
window.addEventListener('pwa-update-available', function (evt) {
    if (!isAdminSession) return; // only notify admin users who can re-authenticate
    showToast('🔄 มีการอัปเดตใหม่ กำลังโหลด...', 5000);
    try {
        var reg = evt.detail && evt.detail.reg ? evt.detail.reg : null;
        if (reg && reg.waiting) {
            reg.waiting.postMessage('SKIP_WAITING');
        }
    } catch (e) { console.warn('[SW] update notification error:', e); }
});


