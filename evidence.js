// evidence.js — ONE still-frame evidence capture + secure upload + LINK to attendance.
//
// Reuses the existing camera stream from app.js (currentStream / #video /
// cameraActive). Does NOT call getUserMedia() again and does NOT touch face
// recognition or the scan loop. Invoked only after a SUCCESSFUL attendance
// (scan.js confirmCheckIn), passing the created Attendance ID.
//
// Flow: capture one frame (offscreen canvas from existing #video) -> JPEG Blob
// -> POST to secure storage (server/storage-service.js) with X-Attendance-Id ->
// store safe reference locally (DataStore fg_evidence) + set evidenceId on the
// attendance record. Failure is best-effort: attendance is NEVER deleted, marked
// absent, or faked — it simply has no linked evidence.
//
// Browser + Node-testable (guarded module.exports; DOM is injected via `capture`).
(function () {
    'use strict';
    var NS = (typeof window !== 'undefined') ? window : (typeof global !== 'undefined' ? global : {});

    var EvidenceCapture = {
        MAX_FILE_BYTES: 512 * 1024, // mirror server cap
        JPEG_QUALITY: 0.82,
        inFlight: false,            // one capture in-flight at a time (reentrant guard)
    };

    function evidenceStorageConfig() {
        var c = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.EVIDENCE_STORAGE) ? CONFIG.EVIDENCE_STORAGE : null;
        if (!c || !c.url || !c.token) return null;
        return c;
    }

    // Pure policy: should we attempt an evidence capture for this attendance event?
    // Reuses the EXISTING stream/state (never starts a new one).
    function shouldCaptureEvidence(studentId, date) {
        if (EvidenceCapture.inFlight) return false;
        if (typeof cameraActive === 'undefined' || !cameraActive) return false; // cam off/unmounted/denied
        if (typeof currentStream === 'undefined' || !currentStream) return false;
        if (typeof DataStore !== 'undefined' && DataStore.hasEvidence && DataStore.hasEvidence(studentId, date)) return false; // dup guard
        return true;
    }

    // DOM capture: ONE frame from the EXISTING video element (srcObject = currentStream).
    // Own offscreen canvas (does NOT touch the scan overlay canvas #canvas).
    // Mirrors horizontally to match the CSS-mirrored <video> (cf. register.js cropFaceThumb).
    function captureFrameFromVideo(video) {
        return new Promise(function (resolve, reject) {
            try {
                if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
                    return resolve(null);
                }
                var canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;   // actual video dims — no upscale
                canvas.height = video.videoHeight;
                var ctx = canvas.getContext('2d');
                ctx.save();
                ctx.scale(-1, 1);                  // mirror to match mirrored <video>
                ctx.translate(-canvas.width, 0);
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                ctx.restore();
                canvas.toBlob(function (blob) { resolve(blob || null); }, 'image/jpeg', EvidenceCapture.JPEG_QUALITY);
            } catch (e) { reject(e); }
        });
    }

    // Upload a Blob to secure storage. `attendanceId` binds evidence to an attendance event.
    function uploadEvidenceBlob(blob, cfg, attendanceId) {
        var headers = { 'Content-Type': blob.type || 'image/jpeg', 'Authorization': 'Bearer ' + cfg.token };
        if (attendanceId) headers['X-Attendance-Id'] = attendanceId;
        return fetch(cfg.url, { method: 'POST', headers: headers, body: blob })
            .then(function (resp) {
                return resp.json().catch(function () { return {}; }).then(function (data) {
                    return { ok: resp.ok, status: resp.status, data: data };
                });
            });
    }

    // Link evidenceId onto the existing attendance record (forward pointer). Idempotent.
    function linkEvidenceOnAttendance(studentId, date, evidenceId) {
        try {
            if (typeof DataStore === 'undefined' || !Array.isArray(attendanceList)) return false;
            var changed = false;
            for (var i = 0; i < attendanceList.length; i++) {
                var r = attendanceList[i];
                if (r.studentId === studentId && r.date === date && !r.evidenceId) {
                    r.evidenceId = evidenceId;
                    changed = true;
                }
            }
            if (changed && typeof saveAttendance === 'function') saveAttendance();
            return changed;
        } catch (e) { console.error('[evidence] link error:', e); return false; }
    }

    // Orchestrator — called after successful attendance. Never throws to the caller.
    // opts: { studentId, date, attendanceId, capture }
    function captureAttendanceEvidence(opts) {
        var studentId = opts && opts.studentId;
        var date = opts && opts.date;
        var attendanceId = opts && opts.attendanceId;
        var capture = opts && opts.capture;

        var cfg = evidenceStorageConfig();
        if (!cfg) { console.warn('[evidence] storage not configured'); return Promise.resolve({ ok: false, reason: 'not_configured' }); }
        if (!shouldCaptureEvidence(studentId, date)) return Promise.resolve({ ok: false, reason: 'skipped' });

        EvidenceCapture.inFlight = true;
        var video = (typeof document !== 'undefined') ? document.getElementById('video') : null;
        var doCapture = capture || function () { return captureFrameFromVideo(video); };
        var _tEvidence = (typeof PM !== 'undefined' && PM && PM.isEnabled()) ? PM.now() : 0;

        return Promise.resolve()
            .then(function () { return doCapture(); })
            .then(function (blob) {
                if (!blob) return { ok: false, reason: 'camera_unavailable' };
                if (blob.size > EvidenceCapture.MAX_FILE_BYTES) return { ok: false, reason: 'too_large', size: blob.size };
                return uploadEvidenceBlob(blob, cfg, attendanceId).then(function (r) {
                    if (r.status === 409 && r.data && r.data.evidenceId) {
                        // Server rejected duplicate attendanceId (race condition guard):
                        // reuse the existing evidence instead of creating a second one.
                        linkEvidenceOnAttendance(studentId, date, r.data.evidenceId);
                        return { ok: true, evidenceId: r.data.evidenceId, storageRef: r.data.storageRef, reused: true, reason: 'duplicate-prevented' };
                    }
                    if (!r.ok || !r.data.evidenceId || !r.data.storageRef) {
                        // FAILURE RULE: attendance already accepted; do NOT delete/rewrite it.
                        // Evidence simply stays "unavailable" for this event.
                        return { ok: false, reason: 'upload_failed', status: r.status, detail: r.data.error };
                    }
                    var now = Date.now();
                    var created = {
                        evidenceId: r.data.evidenceId,
                        studentId: studentId,
                        date: date,
                        attendanceId: (typeof r.data.attendanceId === 'string') ? r.data.attendanceId : attendanceId,
                        storageRef: r.data.storageRef,
                        captureAt: now,
                        fileType: r.data.fileType || 'image/jpeg',
                        fileSize: r.data.fileSize || blob.size,
                        status: 'available',
                        createdAt: now,
                    };
                    var added = (typeof DataStore !== 'undefined' && DataStore.addEvidence) ? DataStore.addEvidence(created) : false;
                    // `added === false` => local duplicate (rare race) — still link attendance.
                    linkEvidenceOnAttendance(studentId, date, r.data.evidenceId);
                    if (typeof showToast === 'function') showToast('📸 บันทึกหลักฐานใบหน้าแล้ว');
                    return { ok: true, evidenceId: r.data.evidenceId, storageRef: r.data.storageRef, added: added };
                });
            })
            .catch(function (err) {
                console.error('[evidence] capture error:', err);
                return { ok: false, reason: 'error', detail: String(err && err.message) };
            })
            .then(function (result) {
                EvidenceCapture.inFlight = false;
                if (typeof PM !== 'undefined' && PM && PM.isEnabled() && _tEvidence) {
                    PM.set('evidenceMs', PM.now() - _tEvidence);
                }
                return result;
            });
    }

    NS.EvidenceCapture = EvidenceCapture;
    NS.evidenceStorageConfig = evidenceStorageConfig;
    NS.shouldCaptureEvidence = shouldCaptureEvidence;
    NS.captureFrameFromVideo = captureFrameFromVideo;
    NS.uploadEvidenceBlob = uploadEvidenceBlob;
    NS.linkEvidenceOnAttendance = linkEvidenceOnAttendance;
    NS.captureAttendanceEvidence = captureAttendanceEvidence;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            EvidenceCapture: EvidenceCapture,
            evidenceStorageConfig: evidenceStorageConfig,
            shouldCaptureEvidence: shouldCaptureEvidence,
            captureFrameFromVideo: captureFrameFromVideo,
            uploadEvidenceBlob: uploadEvidenceBlob,
            linkEvidenceOnAttendance: linkEvidenceOnAttendance,
            captureAttendanceEvidence: captureAttendanceEvidence,
        };
    }
})();
