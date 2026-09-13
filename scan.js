// scan.js — สแกนใบหน้า
let scanInterval         = null;
let currentDetectedLabel = null;
let isScanning           = false;
let isProcessing         = false;
let isCheckinActive      = false; // attendance result is settling (evidence capture in flight) — pause new detections
let lastCheckinAt        = 0;
const CHECKIN_COOLDOWN_MS = 3000; // กันกดซ้ำ/ยิงบันทึกซ้ำเร็วเกินไปหลังเช็กอินสำเร็จ
let confirmCounter      = 0;
let pendingLabel        = null;
let scanResizeHandler   = null;
let currentScanClass    = 'all'; // class filter for scanning (STEP 4 multi-class)

async function startScanning() {
    if (!registeredFaces || registeredFaces.length === 0) {
        showToast('⚠️ ยังไม่มีข้อมูลในระบบ กรุณาลงทะเบียนก่อน');
        return;
    }
    if (isScanning) return;
    // Guard: verify face-api models are loaded before entering the scan loop.
    if (typeof faceModelStatus !== 'undefined' && faceModelStatus !== 'ready') {
        if (faceModelStatus === 'error') {
            setCameraError('❌ โมเดล AI ไม่พร้อม — กรุณารีเฟรชหน้าหรือตรวจสอบการเชื่อมต่อ');
            return;
        }
        // 'loading' state: wait for models to finish loading, then retry.
        setStatusCard('loading', '⏳', 'กำลังโหลดโมเดล AI...');
        const onReady = function () {
            if (typeof faceModelStatus === 'undefined' || faceModelStatus === 'ready') {
                startScanning();
            } else if (faceModelStatus === 'error') {
                setCameraError('❌ โมเดล AI โหลดไม่สำเร็จ — กรุณารีเฟรชหน้า');
            }
        };
        if (typeof waitModelsReady === 'function') {
            waitModelsReady(onReady);
        } else {
            // Fallback: poll faceModelStatus every 500ms for up to 10 seconds.
            var tries = 0, maxTries = 20;
            var iv = setInterval(function () {
                tries++;
                if (faceModelStatus === 'ready') { clearInterval(iv); startScanning(); }
                else if (faceModelStatus === 'error' || tries >= maxTries) {
                    clearInterval(iv);
                    setCameraError('❌ โมเดล AI ไม่พร้อม — กรุณารีเฟรชหน้า');
                }
            }, 500);
        }
        return;
    }
    if (!cameraActive) {
        showToast('⚠️ กล้ำยยังไม่พร้อม กำลังเปิด...');
        await startCamera();
        if (!cameraActive) {
            // CAMERA_ERROR — clear, recoverable, never crashes.
            setCameraError('❌ กล้ำยไม่พร้อม — กด "เริ่มสแกน" อีกครั้งเพื่อลองเปิดกล้ำยใหม่');
            return;
        }
    }
    isScanning = true; isCheckinActive = false;

    document.getElementById('startBtn').disabled = true;
    document.getElementById('stopBtn').disabled  = false;
    document.getElementById('recDot').classList.add('active');
    document.getElementById('scanOverlay').style.display = 'none';
    setStatusCard('detecting', '🔍', 'กำลังค้นหาใบหน้า...');

    const video = document.getElementById('video');
    const canvas = document.getElementById('canvas');
    if (!video || !canvas) { stopScanning(); return; }

    function getVideoDisplaySize(v) {
        const ow = v.offsetWidth, oh = v.offsetHeight;
        const vw = v.videoWidth || 640,  vh = v.videoHeight || 480;
        return { width: (ow > 0 ? ow : vw), height: (oh > 0 ? oh : vh) };
    }

    if (video.readyState < 2) {
        video.onloadedmetadata = function() {
            faceapi.matchDimensions(canvas, getVideoDisplaySize(video));
        };
    } else {
        faceapi.matchDimensions(canvas, getVideoDisplaySize(video));
    }

    // Re-sync the overlay canvas when the device rotates (portrait <-> landscape).
    // Reuses the SAME #video stream — never opens a new camera. Only display sizing changes.
    scanResizeHandler = function () {
        const v = document.getElementById('video');
        const c = document.getElementById('canvas');
        if (!isScanning || !v || !c) return;
        const ds = getVideoDisplaySize(v);
        if ((c.width !== ds.width) || (c.height !== ds.height)) {
            faceapi.matchDimensions(c, ds);
        }
    };
    window.addEventListener('resize', scanResizeHandler);
    window.addEventListener('orientationchange', scanResizeHandler);

    const facesToScan = currentScanClass === 'all'
        ? registeredFaces
        : registeredFaces.filter(s => (s.year||'') === currentScanClass);
    const labeled = facesToScan
        .filter(s => s.descriptors && s.descriptors.length > 0)
        .map(s => new faceapi.LabeledFaceDescriptors(
            `${s.name}|||${s.id}|||${s.year||''}`,
            s.descriptors.map(d => new Float32Array(d))
        ));

    if (labeled.length === 0) {
        showToast('⚠️ ไม่พบข้อมูลใบหน้าในระบบ');
        stopScanning();
        return;
    }

    // อ่านค่าความเข้มงวดจาก CONFIG สดทุกครั้งที่เริ่มสแกน (รองรับการปรับจากหน้าตั้งค่าโดยไม่ต้องรีเฟรช)
    var pm = (typeof PM !== 'undefined') ? PM : null;
    var pmOn = pm ? pm.isEnabled() : false;

    // Candidate search: build LabeledFaceDescriptors + FaceMatcher (once per scan session).
    var tCs0 = pmOn ? pm.now() : 0;
    const matcher = new faceapi.FaceMatcher(labeled, CONFIG.FACE_MATCH_THRESHOLD);
    if (pmOn) {
        pm.set('candidateSearchMs', pm.now() - tCs0);
        pm.set('candidates', labeled.length);
    }
    const ctx = canvas.getContext('2d');

    // Self-scheduling scan loop (STEP 2): replaces fixed setInterval with
    // adaptive setTimeout. Next frame is scheduled only after the current
    // frame completes, preventing queue buildup when inference is slow.
    // When no face is detected, a longer interval (NO_FACE_INTERVAL_MS)
    // reduces unnecessary CPU usage; when a face IS detected, the normal
    // DETECTION_INTERVAL_MS keeps the response snappy.
    var scanTimeout = null;
    var lastVideoTime = -1;  // tracks video.currentTime; skips stale frames (STEP 3)

    function _scheduleNext(delay) {
        if (!isScanning) return;
        scanTimeout = setTimeout(_scanFrame, delay);
    }

    async function _scanFrame() {
        if (!isScanning || isProcessing || isCheckinActive) {
            // Paused — poll quickly to resume when check-in settles.
            _scheduleNext(100);
            return;
        }

        // STEP 3: Quality gate — skip inference on stale or unready frames.
        // No new video frame means no new face to detect; running the SSD
        // model on an identical frame wastes CPU without changing the result.
        // This does NOT affect recognition accuracy.
        if (!video || video.readyState < 2) {
            _scheduleNext(50);  // video loading — poll quickly
            return;
        }
        if (video.currentTime === lastVideoTime) {
            _scheduleNext(80);  // no new frame — skip inference
            return;
        }
        lastVideoTime = video.currentTime;

        isProcessing = true;
        var frameStart = pmOn ? pm.now() : 0;
        var faceDetected = false;

        try {
            if (pmOn) pm.resetFrame();

            const t0 = pmOn ? pm.now() : ((performance && performance.now) ? performance.now() : Date.now());
            const detections = await faceapi
                .detectAllFaces(video, new faceapi.SsdMobilenetv1Options({ minConfidence: CONFIG.FACE_DETECT_MIN_CONFIDENCE }))
                .withFaceLandmarks()
                .withFaceDescriptors();

            if (pmOn) pm.set('inferenceMs', pm.now() - t0);

            const dSize = getVideoDisplaySize(video);
            const resized = faceapi.resizeResults(detections, dSize);
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (resized.length === 0) {
                confirmCounter = 0; pendingLabel = null;
                hideDetectCard(); hideUnknownCard();
                setStatusCard('detecting', '🔍', 'กำลังค้นหาใบหน้า...');
                faceDetected = false;
            } else {
                faceDetected = true;
                // Validate: only 1 face at a time
                if (resized.length > 1) {
                    confirmCounter = 0; pendingLabel = null;
                    setStatusCard('detecting', '⚠️', 'กรุณาให้มีใบหน้าเพียง 1 คนในกรอบสแกน');
                    hideDetectCard(); hideUnknownCard();
                } else {
                    setStatusCard('recognizing', '🧬', 'กำลังยืนยันตัวตน...');

                    if (typeof Calibration !== 'undefined' && Calibration.isActive()) {
                        const face = resized[0];
                        const lat = (performance && performance.now) ? (performance.now() - t0) : 0;
                        const cal = Calibration.recordFrame(face.descriptor, face.detection.score, lat);
                        drawCornerBox(ctx, face.detection.box, '#0ea5e9');
                        const exp = Calibration.expectedId == null ? '__stranger__' : Calibration.expectedId;
                        const mark = (cal.nearestId === Calibration.expectedId) ? '✅' : '❌';
                        setStatusCard('recognizing', '🧪', `สอนถาวร: ${exp} | ใกล้สุด=${cal.nearestId || '-'} | d=${cal.distance.toFixed(3)} ${mark}`);
                        hideDetectCard(); hideUnknownCard();
                    } else {
                        // Face matching
                        var tMatch0 = pmOn ? pm.now() : 0;
                        const results = resized.map(d => matcher.findBestMatch(d.descriptor));
                        if (pmOn) {
                            pm.set('matchingMs', pm.now() - tMatch0);
                            pm.set('faceCount', resized.length);
                            // Count total comparisons: sum of all candidate descriptors × faces detected
                            var cmp = 0;
                            for (var ci = 0; ci < labeled.length; ci++) {
                                cmp += labeled[ci].descriptors.length;
                            }
                            pm.set('comparisons', cmp * resized.length);
                        }

                        let foundKnown = false, foundUnknown = false;

                        results.forEach((result, i) => {
                            const { detection, landmarks } = resized[i];
                            const box      = detection.box;
                            const isUnknown = result.label === 'unknown';
                            const color    = isUnknown ? '#dc2626' : '#0ea5e9';
                            const conf  = Math.round((1 - result.distance) * 100);

                            // Face size validation
                            const faceArea = box.width * box.height;
                            const frameArea = video.videoWidth * video.videoHeight;
                            if (faceArea < frameArea * 0.05) {
                                confirmCounter = 0; pendingLabel = null;
                                setStatusCard('detecting', '↔️', 'ขยับเข้าใกล้กล้ำอีกนิด');
                                return;
                            }

                            new faceapi.draw.DrawFaceLandmarks(landmarks, { lineWidth:1, drawLines:true, color }).draw(canvas);
                            drawCornerBox(ctx, box, color);

                            const label = isUnknown ? '[ UNKNOWN ]' : `[ ${result.label.split('|||')[0]} ]`;
                            ctx.save(); ctx.scale(-1,1);
                            ctx.fillStyle = color;
                            ctx.font = 'bold 13px JetBrains Mono, monospace';
                            ctx.fillText(label, -(box.x + box.width), box.y - 8);
                            if (!isUnknown) { ctx.fillStyle='rgba(14,165,233,0.85)'; ctx.font='11px monospace'; ctx.fillText(`${conf}%`, -(box.x + box.width), box.y + box.height + 16); }
                            ctx.restore();

                            const liveLabel = isUnknown ? null : result.label;
                            const st = confirmStep({ label: pendingLabel, counter: confirmCounter }, liveLabel, CONFIG.FACE_CONFIRM_FRAMES);
                            pendingLabel = st.label;
                            confirmCounter = st.counter;
                            if (st.confirmed) {
                                foundKnown = true;
                                if (currentDetectedLabel !== liveLabel) {
                                    currentDetectedLabel = liveLabel;
                                    showDetectCard(liveLabel, conf);
                                }
                            } else if (isUnknown) {
                                foundUnknown = true;
                            }
                        });
                        if (!foundKnown) hideDetectCard();
                        if (foundUnknown && !foundKnown) showUnknownCard(); else hideUnknownCard();
                        if (foundKnown) setStatusCard('success', '✅', 'เช็กชื่อสำเร็จ');
                    }
                }
            }
        } catch (err) {
            console.error('Scan detection error:', err);
            if (typeof showToast === 'function') showToast('⚠️ เกิดข้อผิดพลาปัจก่อนสแกน กรุณาลองใหม่อีกครั้ง');
            // STEP 7: log failed scan
            logScanEvent(null, null, null, 'failed', null, null, null, String(err && err.message));
        } finally {
            isProcessing = false;
            if (pmOn) {
                pm.set('totalMs', pm.now() - frameStart);
                pm.tick();
            }
        }

        // Adaptive scheduling: shorter interval when face present, longer when idle.
        var delay = faceDetected ? CONFIG.DETECTION_INTERVAL_MS : CONFIG.NO_FACE_INTERVAL_MS;
        _scheduleNext(Math.max(0, delay - (pmOn ? (pm.now() - frameStart) : 0)));
    }

    // Start the self-scheduling scan loop
    _scanFrame();
}

function drawCornerBox(ctx, box, color) {
    const { x, y, width:w, height:h } = box;
    const s = 22;
    ctx.strokeStyle = color; ctx.lineWidth = 2.5;
    ctx.save(); ctx.scale(-1,1);
    const mx = -(x + w);
    ctx.beginPath();
    ctx.moveTo(mx, y+s);    ctx.lineTo(mx, y);     ctx.lineTo(mx+s, y);
    ctx.moveTo(mx+w-s, y);  ctx.lineTo(mx+w, y);   ctx.lineTo(mx+w, y+s);
    ctx.moveTo(mx, y+h-s);  ctx.lineTo(mx, y+h);   ctx.lineTo(mx+s, y+h);
    ctx.moveTo(mx+w-s, y+h);ctx.lineTo(mx+w, y+h); ctx.lineTo(mx+w, y+h-s);
    ctx.restore();
    ctx.stroke();
}

// สลับสถานะการ์ดสถานะ AI ด้านบน (detecting/recognizing/success/unknown)
function setStatusCard(state, icon, text) {
    const card = document.getElementById('statusCard');
    if (card) card.className = 'status-card state-' + state;
    const iconEl = document.getElementById('statusIcon');
    if (iconEl) iconEl.textContent = icon;
    const textEl = document.getElementById('statusText');
    if (textEl) textEl.textContent = text;
}

function showDetectCard(label, confidence) {
    hideUnknownCard();
    const parts = label.split('|||');
    const studentId = parts[1] || '';
    document.getElementById('detectedName').textContent = parts[0]||'—';
    document.getElementById('detectedSub').textContent  = `${parts[1]||'—'}  •  ${parts[2]||'—'}`;
    const confEl = document.getElementById('detectConfidence');
    if (confEl) confEl.textContent = `ความมั่นใจในการจับคู่: ${confidence}%`;
    document.getElementById('detectCard').style.display  = 'block';
    document.getElementById('checkinSuccess').style.display = 'none';
    document.getElementById('checkinBtn').style.display     = 'flex';

    const existing = DataStore.getAttendance().find(r => r.studentId === studentId && r.date === DateHelper.today());
    if (existing) {
        document.getElementById('checkinBtn').style.display     = 'none';
        document.getElementById('checkinSuccess').style.display = 'block';
        document.getElementById('checkinSuccess').className     = 'checkin-duplicate';
        document.getElementById('checkinSuccess').textContent   = `⚠️ นักเรียนคนนี้เช็กชื่อแล้ว (เวลา ${existing.time})`;
        setStatusCard('duplicate', '⚠️', 'เช็กชื่อวันนี้แล้ว');
        // STEP 7: log duplicate scan to server
        var _parts = label.split('|||');
        logScanEvent(studentId || null, parts[0] || null, parts[2] || null, 'duplicate', 'duplicate', null, confidence);
    }
}

function hideDetectCard() {
    if (!currentDetectedLabel) return;
    currentDetectedLabel = null;
    const dc = document.getElementById('detectCard');
    if (dc) dc.style.display = 'none';
    const cs = document.getElementById('checkinSuccess');
    if (cs) cs.className = 'checkin-success';
}
function showUnknownCard() {
    const el = document.getElementById('unknownCard');
    if (el) el.style.display = 'block';
    setStatusCard('unknown', '❌', 'ไม่พบข้อมูลนักเรียน');
    // STEP 7: log unknown scan (rate-limited to avoid spam on every frame)
    var now = Date.now();
    if (now - (window._lastUnknownLog || 0) > 3000) {
        window._lastUnknownLog = now;
        logScanEvent(null, null, null, 'unknown', null, null, null);
    }
}
function hideUnknownCard() {
    const el = document.getElementById('unknownCard');
    if (el) el.style.display = 'none';
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Render the post-attendance result card (reuses #checkinSuccess).
// result: 'pending' (capturing) | 'saved' (evidence ok) | 'error' (evidence failed)
// student: { name, studentId, year, time }
function renderCheckinSuccess(result, student) {
    const el = document.getElementById('checkinSuccess');
    if (!el) return;
    let evidenceClass, evidenceText;
    if (result === 'saved') {
        evidenceClass = 'saved';   evidenceText = '✓ บันทึกภาพหลักฐานแล้ว';
    } else if (result === 'error') {
        evidenceClass = 'error';   evidenceText = '⚠️ ไม่สามารถบันทึกภาพหลักฐานได้';
    } else {
        evidenceClass = 'pending'; evidenceText = '📸 กำลังบันทึกภาพหลักฐาน...';
    }
    el.className = 'checkin-success';
    el.innerHTML =
        '<div class="success-header">✅ เช็กชื่อสำเร็จ</div>' +
        '<div class="success-student">' + escapeHtml(student.name) + '</div>' +
        '<div class="success-meta">' + escapeHtml(student.studentId) + '  •  ' + escapeHtml(student.year) + '</div>' +
        '<div class="success-time">' + escapeHtml(student.time) + '</div>' +
        '<div class="success-evidence ' + evidenceClass + '">' + evidenceText + '</div>';
    el.style.display = 'block';
    const btn = document.getElementById('checkinBtn');
    if (btn) btn.style.display = 'none';
}

// CAMERA_ERROR: clear status + recovery action. Never throws.
function setCameraError(msg) {
    setStatusCard('camera-error', '❌', msg);
    if (typeof showToast === 'function') showToast('⚠️ ' + msg);
}

function stopScanning() {
    if (scanInterval) { clearTimeout(scanInterval); } scanInterval = null; isScanning = false; currentDetectedLabel = null; isProcessing = false; isCheckinActive = false;
    if (scanResizeHandler) { window.removeEventListener('resize', scanResizeHandler); window.removeEventListener('orientationchange', scanResizeHandler); scanResizeHandler = null; }
    const canvas = document.getElementById('canvas');
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled  = true;
    document.getElementById('recDot').classList.remove('active');
    document.getElementById('scanOverlay').style.display = 'flex';
    document.getElementById('detectCard').style.display  = 'none';
    hideUnknownCard();
    setStatusCard('ready', '✅', 'พร้อมสแกน');
}

function changeScanClass() {
    const sel = document.getElementById('scanClassFilter');
    const val = sel ? sel.value : 'all';
    if (val === currentScanClass) return;
    const prev = currentScanClass;
    currentScanClass = val;
    if (isScanning) {
        stopScanning();
        startScanning();
    }
    const label = val === 'all' ? 'ทุกชั้นปี' : val;
    showToast(`🔍 กรองเป็น: ${label}`);
}

function confirmCheckIn() {
    if (!currentDetectedLabel) return;
    if (Date.now() - lastCheckinAt < CHECKIN_COOLDOWN_MS) return; // กันกดซ้ำเร็วเกินไป
    const btn = document.getElementById('checkinBtn');
    if (btn) btn.disabled = true;

    const parts     = currentDetectedLabel.split('|||');
    const name      = parts[0]||'—';
    const studentId = parts[1]||'—';
    const year      = parts[2]||'—';
    const now       = DateHelper.now();
    const today     = DateHelper.today();
    const time      = DateHelper.toThaiTime(now);
    const weekNum   = DateHelper.getAcademicWeekNum(now);

    if (DataStore.isAttendedToday(studentId)) {
        showToast(`⚠️ ${name} ลงชื่อแล้ววันนี้`);
        if (btn) btn.disabled = false;
        return;
    }
    if (DateHelper.isAfterEndTime(time)) {
        showToast('⏰ เกินเวลาสิ้นสุดการเช็กชื่อแล้ว');
        if (btn) btn.disabled = false;
        return;
    }

    const record = { name, studentId, year, date:today, time, weekNum, method:'ใบหน้า (AI)', timestamp: now.getTime() };

    // ATTENDANCE_PROCESSING -> commit record (ID assigned by DataStore.addAttendance)
    setStatusCard('processing', '⏳', 'กำลังบันทึกการเข้าแถว...');
    DataStore.addAttendance(record);
    if (typeof syncScanAttendance === 'function') syncScanAttendance(record);
    attendanceList = DataStore.getAttendance();
    updateStats();
    lastCheckinAt = Date.now();

    const student = { name: name, studentId: studentId, year: year, time: time };
    document.getElementById('checkinBtn').style.display     = 'none';
    document.getElementById('checkinSuccess').style.display = 'block';

    // ATTENDANCE accepted -> switch to evidence capture UI (best-effort, non-blocking).
    isCheckinActive = true;
    setStatusCard('capturing', '📸', 'กำลังบันทึกภาพหลักฐาน...');
    renderCheckinSuccess('pending', student);
    showToast(`✅ ${name} ลงชือเข้าแถรแล้ว (${time})`);
    if (btn) btn.disabled = false;

    function settleEvidence(res) {
        const ok = res && res.ok;
        if (ok) {
            renderCheckinSuccess('saved', student);
            setStatusCard('success', '✅', 'เช็ขชือสำเร็จ');
            // STEP 7: log successful scan with evidence ref
            logScanEvent(studentId, student.name || null, student.year || null, 'recognized', 'present', res.evidenceId || null, conf);
        } else {
            // EVIDENCE_ERROR: attendance remains successful; do NOT say evidence saved.
            renderCheckinSuccess('error', student);
            setStatusCard('evidence-error', '⚠️', 'เช็ขชือสำเร็จ (หลักฐานไม่สมบูรณ์)');
            // STEP 7: log successful scan without evidence
            logScanEvent(studentId, student.name || null, student.year || null, 'recognized', 'present', null, conf, res.reason);
        }
        isCheckinActive = false;
        // Resume normal detection on the next frame (next face will re-send the banner).
    }

    if (typeof captureAttendanceEvidence === 'function') {
        captureAttendanceEvidence({ studentId: studentId, date: today, attendanceId: record.id })
            .then(settleEvidence)
            .catch(function (err) {
                console.error('[scan] evidence capture failed:', err);
                settleEvidence({ ok: false, reason: 'error' });
            });
    } else {
        // Evidence feature not wired — attendance still fully successful.
        settleEvidence({ ok: false, reason: 'not_configured' });
    }
}
