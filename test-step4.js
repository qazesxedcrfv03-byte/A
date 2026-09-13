'use strict';
/*
 * STEP 4/5 validation harness (in-process storage server).
 * Verifies:
 *   - existing camera stream is reused (no getUserMedia),
 *   - exactly one frame captured + blob -> secure storage -> reference,
 *   - correct attendance ID / student / timestamp linkage,
 *   - one evidence per attendance event (client hasEvidence + server 409 reuse),
 *   - no duplicate attendance, no orphan evidence,
 *   - failure best-effort (attendance kept, no fake evidence) when server is down.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const IN_SERVER = path.basename(__dirname) === 'server';

const TOKEN = 'step4-test-token';
const PORT = 3090;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-step4-'));
const storageDir = path.join(tmpRoot, 'storage', 'evidence');
const dataDir = path.join(tmpRoot, 'data');
const metaFile = path.join(dataDir, 'evidence.json');

process.env.EVIDENCE_PORT = String(PORT);
process.env.EVIDENCE_ADMIN_TOKEN = TOKEN;
process.env.EVIDENCE_STORAGE_DIR = storageDir;
process.env.EVIDENCE_DATA_DIR = dataDir;
process.env.EVIDENCE_MAX_BYTES = String(512 * 1024);
process.env.EVIDENCE_ALLOWED_ORIGINS = '*';

const svc = require(IN_SERVER
    ? path.join(__dirname, '..', 'server', 'storage-service.js')
    : path.join(__dirname, 'storage-service.js'));

let pass = 0, fail = 0;
function assert(name, cond, extra = '') {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra ? '  :: ' + extra : '')); }
}

// --- spy: capture must NEVER call getUserMedia (existing stream reused) ---
let gdmCalls = 0;
Object.defineProperty(global, 'navigator', {
    value: { mediaDevices: { getUserMedia: () => { gdmCalls++; throw new Error('getUserMedia must not be called'); }, enumerateDevices: async () => [] } },
    configurable: true, writable: true,
});

// globals evidence.js reads at runtime
const DATASTORE = {
    evidence: [], attendance: [],
    addEvidence(rec) { DATASTORE.evidence.push(rec); return true; },
    hasEvidence: (s, d) => DATASTORE.evidence.some(e => e.studentId === s && e.date === d),
};
global.CONFIG = { EVIDENCE_STORAGE: { url: `http://127.0.0.1:${PORT}/api/evidence`, token: TOKEN } };
global.DataStore = DATASTORE;
global.cameraActive = true;
global.currentStream = { id: 'existing-stream' };
global.attendanceList = DATASTORE.attendance;
global.saveAttendance = () => true;
global.showToast = () => {};

const evidence = require(IN_SERVER
    ? path.join(__dirname, '..', 'evidence.js')
    : path.join(__dirname, 'evidence.js'));

function makeJpeg() {
    return Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9]);
}
const meta = () => { try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (e) { return []; } };

(async () => {
    // ===== POLICY =====
    assert('policy: captures when stream active + no evidence', evidence.shouldCaptureEvidence('S1', '2026-08-24') === true);
    global.cameraActive = false;
    assert('policy: skip when camera unavailable (cameraActive=false)', evidence.shouldCaptureEvidence('S1', '2026-08-24') === false);
    global.cameraActive = true;
    const ps = global.currentStream; global.currentStream = null;
    assert('policy: skip when stream missing (unmounted)', evidence.shouldCaptureEvidence('S1', '2026-08-24') === false);
    global.currentStream = ps;

    // dup guard + inFlight + no-getUserMedia
    DATASTORE.evidence.push({ evidenceId: 'ev_x', studentId: 'S1', date: '2026-08-24', storageRef: 'x.jpg', status: 'available' });
    assert('policy: skip when evidence already exists (dup) for event', evidence.shouldCaptureEvidence('S1', '2026-08-24') === false);
    DATASTORE.evidence = [];
    evidence.EvidenceCapture.inFlight = true;
    assert('policy: skip while a capture is in-flight', evidence.shouldCaptureEvidence('S1', '2026-08-24') === false);
    evidence.EvidenceCapture.inFlight = false;

    const savedCfg = global.CONFIG.EVIDENCE_STORAGE;
    global.CONFIG.EVIDENCE_STORAGE = null;
    const rNotCfg = await evidence.captureAttendanceEvidence({ studentId: 'S1', date: '2026-08-24', attendanceId: crypto.randomUUID() });
    assert('policy: not_configured -> skipped', rNotCfg.ok === false && rNotCfg.reason === 'not_configured');
    assert('policy: getUserMedia not called during policy checks', gdmCalls === 0);
    global.CONFIG.EVIDENCE_STORAGE = savedCfg;

    // ===== INTEGRATION: success -> correct attendance id / student / timestamp =====
    // Seed the attendance record (created by DataStore.addAttendance in confirmCheckIn):
    const ATT_ID = crypto.randomUUID();
    DATASTORE.attendance.push({ studentId: 'S1', date: '2026-08-24', name: 'Test', time: '07:45:00', method: 'ใบหน้า (AI)', id: crypto.randomUUID() });
    const blob = new Blob([makeJpeg()], { type: 'image/jpeg' });
    const r = await evidence.captureAttendanceEvidence({
        studentId: 'S1', date: '2026-08-24', attendanceId: ATT_ID,
        capture: () => Promise.resolve(blob),
    });
    assert('integration: upload ok (server 201)', r.ok === true, JSON.stringify(r));
    assert('integration: evidenceId returned', !!r.evidenceId, JSON.stringify(r));
    assert('integration: storageRef returned', !!r.storageRef, JSON.stringify(r));

    const serverRec = meta().find(e => e.evidenceId === r.evidenceId);
    assert('server: evidence stored', !!serverRec, JSON.stringify(serverRec));
    assert('server: attendanceId matches sent Attendance ID', serverRec && serverRec.attendanceId === ATT_ID, `got=${serverRec && serverRec.attendanceId}`);
    // student is on the attendance side (proper relation); server stores attendanceId FK only
    assert('server: no denormalized studentId on evidence (relation via attendance)', serverRec && serverRec.studentId === undefined, `got=${serverRec && serverRec.studentId}`);
    assert('server: captureAt is a real timestamp (number, recent)', serverRec && typeof serverRec.captureAt === 'number' && serverRec.captureAt > Date.now() - 10000 && serverRec.captureAt <= Date.now());
    assert('server: fileSize is a positive number', serverRec && typeof serverRec.fileSize === 'number' && serverRec.fileSize > 0);
    assert('server: status available', serverRec && serverRec.status === 'available');
    assert('server: file persisted on disk', fs.readdirSync(storageDir).some(f => f === r.storageRef));
    // local evidence reference carries the student (resolvable from attendance linkage)
    const localEv = DATASTORE.evidence.find(e => e.evidenceId === r.evidenceId);
    assert('local: evidence reference has correct studentId', localEv && localEv.studentId === 'S1', JSON.stringify(localEv));
    assert('local: evidence reference has correct attendanceId', localEv && localEv.attendanceId === ATT_ID, JSON.stringify(localEv));
    assert('integration: attendance record linked with evidenceId', DATASTORE.attendance.find(x => x.studentId === 'S1' && x.date === '2026-08-24' && x.evidenceId === r.evidenceId));
    assert('integration: no getUserMedia during capture', gdmCalls === 0);

    // ===== ONE EVIDENCE: sequential dup -> server 409 reuse =====
    const filesBeforeDup = fs.readdirSync(storageDir).length;
    DATASTORE.hasEvidence = () => false; // let the SERVER enforce uniqueness this round
    const rDup = await evidence.captureAttendanceEvidence({
        studentId: 'S1', date: '2026-08-24', attendanceId: ATT_ID,
        capture: () => Promise.resolve(blob),
    });
    assert('dup: second capture for same attendance -> 409 reuse (ok:true, reused:true)', rDup.ok === true && rDup.reused === true, JSON.stringify(rDup));
    assert('dup: server kept exactly ONE evidence for attendanceId', meta().filter(e => e.attendanceId === ATT_ID).length === 1);
    assert('dup: no extra file written on 409', fs.readdirSync(storageDir).length === filesBeforeDup, `files=${fs.readdirSync(storageDir).length}`);
    DATASTORE.hasEvidence = (s, d) => DATASTORE.evidence.some(e => e.studentId === s && e.date === d); // restore

    // ===== RACE: two concurrent uploads, same attendanceId -> one evidence =====
    const RACE_ATT = crypto.randomUUID();
    const before = fs.readdirSync(storageDir).length;
    const [a, b] = await Promise.all([
        evidence.uploadEvidenceBlob(blob, global.CONFIG.EVIDENCE_STORAGE, RACE_ATT),
        evidence.uploadEvidenceBlob(blob, global.CONFIG.EVIDENCE_STORAGE, RACE_ATT),
    ]);
    assert('race: both calls resolve (no throw)', a && b && (a.status === 201 || a.status === 409) && (b.status === 201 || b.status === 409), `a=${a.status} b=${b.status}`);
    const raceEvs = meta().filter(e => e.attendanceId === RACE_ATT);
    assert('race: server stored exactly ONE evidence for attendanceId', raceEvs.length === 1, `count=${raceEvs.length}`);
    const raceId = raceEvs[0].evidenceId;
    assert('race: both responses resolve to same evidenceId',
        (a.status === 201 ? a.data.evidenceId : a.data.evidenceId) === raceId &&
        (b.status === 201 ? b.data.evidenceId : b.data.evidenceId) === raceId);
    assert('race: no orphan evidence (single stored reference)', meta().every(e => e.status === 'available' || e.status === 'missing'));

    // ===== FAILURE: server unreachable -> attendance kept, no fake evidence =====
    const S5_ATT = crypto.randomUUID();
    global.CONFIG.EVIDENCE_STORAGE = { url: 'http://127.0.0.1:59999/api/evidence', token: TOKEN };
    DATASTORE.evidence = []; DATASTORE.attendance.push({ studentId: 'S5', date: '2026-08-25', name: 'T', time: '08:00:00', method: 'ใบหน้า (AI)' });
    const rf = await evidence.captureAttendanceEvidence({ studentId: 'S5', date: '2026-08-25', attendanceId: S5_ATT, capture: () => Promise.resolve(blob) });
    assert('failure: best-effort -> ok:false', rf.ok === false, JSON.stringify(rf));
    assert('failure: attendance NOT deleted/marked absent', DATASTORE.attendance.some(x => x.studentId === 'S5' && x.date === '2026-08-25'));
    assert('failure: no evidenceId written on failure', !DATASTORE.attendance.find(x => x.studentId === 'S5' && x.date === '2026-08-25').evidenceId);
    assert('failure: no orphan/fake evidence record created', DATASTORE.evidence.filter(e => e.studentId === 'S5').length === 0);
    global.CONFIG.EVIDENCE_STORAGE = savedCfg;

    // ===== AUTHZ: unauthenticated upload to storage is rejected server-side =====
    const unauth = await fetch(`http://127.0.0.1:${PORT}/api/evidence`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Attendance-Id': crypto.randomUUID() }, body: blob });
    assert('authz: upload without token -> 401', unauth.status === 401, `status=${unauth.status}`);

    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    try { svc.server.close(); } catch (e) { /* ignore */ }
    setTimeout(() => process.exit(fail === 0 ? 0 : 1), 100);
})().catch(e => { console.error('harness error:', e); process.exit(1); });
