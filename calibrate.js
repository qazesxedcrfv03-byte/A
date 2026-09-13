// calibrate.js — admin/threshold-calibration tooling.
// Pure metric helpers (computeMetrics, sweepThresholds, recommendThreshold) are
// side-effect-free and unit-testable. The in-browser collection hook (Calibration)
// records the true nearest-student distance per frame so a real threshold can be
// tuned without re-running the model. Does NOT change production CONFIG values.

// Pure temporal-confirmation state machine for recognition confirmation.
// liveLabel = matcher best label, or null for UNKNOWN.
// confirmed=true only when the SAME non-unknown label persists for framesNeeded
// consecutive frames; any change (incl. UNKNOWN) resets the streak.
function confirmStep(prev, liveLabel, framesNeeded) {
    const next = { label: liveLabel, counter: 1, confirmed: false };
    if (liveLabel !== null && liveLabel === prev.label) {
        next.counter = prev.counter + 1;
    }
    if (liveLabel !== null && next.counter >= framesNeeded) {
        next.confirmed = true;
    }
    return next;
}

var FaceCal = FaceCal || {};

function candidateThresholds() {
    const list = [];
    for (let t = 0.30; t <= 0.80; t = Math.round((t + 0.02) * 1000) / 1000) {
        list.push(Math.round(t * 100) / 100);
    }
    return list;
}

// samples: [{ expectedId, nearestId, distance, detectConf, latencyMs }]
// expectedId = null/"" means "expected stranger" (a correct UNKNOWN decision = true negative)
function computeMetrics(samples, threshold) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    let sumLatency = 0, confSum = 0, confN = 0;
    for (const s of samples) {
        const decided = (s.distance <= threshold) ? s.nearestId : null; // null => UNKNOWN
        const expect = (s.expectedId == null || s.expectedId === '') ? null : String(s.expectedId);
        if (decided === null) {
            if (expect === null) tn++;
            else fn++;
        } else if (expect !== null && decided === expect) {
            tp++;
        } else {
            fp++; // wrong student (the critical error)
        }
        sumLatency += s.latencyMs || 0;
        if (s.detectConf != null) { confSum += s.detectConf; confN++; }
    }
    const total = samples.length || 1;
    return {
        threshold, total, tp, fp, fn, tn,
        accuracy: (tp + tn) / total,
        tpr: tp / (tp + fn || 1),              // recall of known students
        fpr: fp / total,                       // wrong-student rate (safety-critical)
        fnr: fn / (tp + fn || 1),              // miss rate for known students
        unknownRate: (fn + tn) / total,        // frames rejected as UNKNOWN
        avgLatencyMs: sumLatency / total,
        avgDetectConf: confN ? confSum / confN : 0
    };
}

function sweepThresholds(samples, candidates) {
    return (candidates || candidateThresholds()).map(t => computeMetrics(samples, t));
}

// Advisory: minimise wrong-student FPR while keeping known-student recall >= 0.95.
function recommendThreshold(sweep) {
    const tprTarget = 0.95;
    let best = null;
    for (const m of sweep) {
        const meets = m.tpr >= tprTarget;
        const score = (meets ? 0 : 1e6) + m.fpr * 1e3 - m.tpr * 1e-2;
        if (!best || score < best.score || (score === best.score && m.fpr < best.m.fpr)) {
            best = { score: score, m: m, tprOk: meets };
        }
    }
    return best ? { threshold: best.m.threshold, tprOk: best.tprOk, metrics: best.m } : null;
}

var Calibration = {
    active: false,
    expectedId: null,
    samples: [],
    start(expectedId) {
        this.expectedId = expectedId;
        this.samples = [];
        this.active = true;
    },
    stop() {
        this.active = false;
        this.expectedId = null;
    },
    isActive() { return this.active; },
    // argmin over registered faces -> { nearestId, distance }; appends a sample.
    recordFrame(descriptor, detectConf, latencyMs) {
        const reg = (typeof registeredFaces !== 'undefined') ? registeredFaces : [];
        let bestId = null, bestDist = Infinity;
        for (const s of reg) {
            if (!s || !s.descriptors || !s.descriptors.length) continue;
            for (const d of s.descriptors) {
                let dist;
                try {
                    dist = (typeof faceapi !== 'undefined') ? faceapi.euclideanDistance(descriptor, new Float32Array(d)) : Infinity;
                } catch (e) { dist = Infinity; }
                if (dist < bestDist) { bestDist = dist; bestId = s.id; }
            }
        }
        const sample = {
            expectedId: this.expectedId,
            nearestId: bestId,
            distance: isFinite(bestDist) ? bestDist : 0,
            detectConf: detectConf || 0,
            latencyMs: latencyMs || 0,
            ts: Date.now()
        };
        this.samples.push(sample);
        return { nearestId: bestId, distance: sample.distance };
    },
    metrics(threshold) { return computeMetrics(this.samples, threshold); },
    sweep(candidates) { return sweepThresholds(this.samples, candidates || candidateThresholds()); },
    report(candidates) {
        const c = candidates || candidateThresholds();
        const sw = this.sweep(c);
        const rec = recommendThreshold(sw);
        return { expectedId: this.expectedId, n: this.samples.length, sweep: sw, recommendation: rec };
    },
    exportCsv() {
        const rows = [['threshold', 'total', 'tp', 'fp', 'fn', 'tn', 'accuracy', 'tpr', 'fpr', 'fnr', 'unknownRate', 'avgLatencyMs', 'avgDetectConf']];
        for (const m of this.sweep()) {
            rows.push([m.threshold, m.total, m.tp, m.fp, m.fn, m.tn,
                (m.accuracy).toFixed(4), (m.tpr).toFixed(4), (m.fpr).toFixed(4), (m.fnr).toFixed(4),
                (m.unknownRate).toFixed(4), (m.avgLatencyMs).toFixed(2), (m.avgDetectConf).toFixed(4)]);
        }
        return rows.map(r => r.join(',')).join('\n');
    }
};

function toggleCalibration(on) {
    const controls = document.getElementById('calControls');
    if (controls) controls.style.display = on ? 'block' : 'none';
    if (!on) { Calibration.stop(); }
    else { populateCalibrationStudents(); }
}

function populateCalibrationStudents() {
    const sel = document.getElementById('calStudent');
    if (!sel) return;
    sel.innerHTML = '';
    const ph = document.createElement('option'); ph.value = ''; ph.textContent = 'เลือกผู้ใช้ที่ถ่ายทอน'; sel.appendChild(ph);
    const stranger = document.createElement('option'); stranger.value = '__stranger__'; stranger.textContent = '__stranger__ (ใครไม่ได้เป็นนักศึกษา)'; sel.appendChild(stranger);
    try {
        const students = DataStore.getStudents();
        for (const s of students) {
            const o = document.createElement('option'); o.value = s.id; o.textContent = `${s.name} (${s.id})`;
            sel.appendChild(o);
        }
    } catch (e) { console.error('populateCalibrationStudents:', e); }
}

function startCalibrationRun() {
    const chk = document.getElementById('calibrateMode');
    if (!chk || !chk.checked) { showToast('⚠️ เปิดโหมดสอนถาวรก่อน'); return; }
    const sel = document.getElementById('calStudent');
    if (!sel) return;
    const val = sel.value;
    if (!val) { showToast('⚠️ เลือกผู้ใช้หรือ __stranger__ ก่อน'); return; }
    const expectedId = (val === '__stranger__') ? null : val;
    Calibration.start(expectedId);
    const l = document.getElementById('calStatus');
    if (l) l.textContent = `กำลังบันทึก... expected=${expectedId == null ? '__stranger__ (นอกระบบ)' : expectedId}  จำนวน=${Calibration.samples.length}`;
    showToast('▶️ เริ่มสอนถาวร');
}

function stopCalibrationRun() {
    if (Calibration.active) {
        Calibration.stop();
        const l = document.getElementById('calStatus');
        if (l) l.textContent = 'หยุดแล้ว';
        showToast('⏹ หยุดสอนถาวร');
    }
}

function runCalibrationSweep() {
    const out = document.getElementById('calReport');
    if (!out) return;
    if (Calibration.samples.length === 0) { out.innerHTML = 'ยังไม่มีข้อมูล ให้เริ่มบันทึกก่อน'; return; }
    const r = Calibration.report();
    const rows = ['<tr><th>Threshold</th><th>Accuracy</th><th>TPR</th><th>FPR(ผิด)</th><th>FNR(พลาด)</th><th>Unknown%</th><th>เฉลี่ย ms</th></tr>'];
    for (const m of r.sweep) {
        rows.push(`<tr><td>${m.threshold.toFixed(2)}</td><td>${(m.accuracy * 100).toFixed(1)}%</td><td>${(m.tpr * 100).toFixed(1)}%</td><td>${(m.fpr * 100).toFixed(2)}%</td><td>${(m.fnr * 100).toFixed(1)}%</td><td>${(m.unknownRate * 100).toFixed(1)}%</td><td>${m.avgLatencyMs.toFixed(0)}</td></tr>`);
    }
    let rec = '';
    if (r.recommendation) {
        const m = r.recommendation.metrics;
        rec = `<div style="margin-top:8px"><b>แนะนำ (ยังไม่นำไปใช้)</b>: ค่าธงศ์ ${r.recommendation.threshold.toFixed(2)} (TPR≥0.95: ${r.recommendation.tprOk ? 'ใช่' : 'ไม่'}) — Accuracy ${(m.accuracy * 100).toFixed(1)}% / FPR(ผิด) ${(m.fpr * 100).toFixed(2)}% / FNR ${(m.fnr * 100).toFixed(1)}%</div>`;
    }
    const exp = r.expectedId == null ? '__stranger__' : r.expectedId;
    out.innerHTML = `<p style="margin:0 0 6px"><b>ตัวอย่างที่เก็บ</b>: ${r.n} เฟรม (expected=${exp})</p><table><tbody>${rows.join('')}</tbody></table>${rec}<div style="margin-top:6px;color:var(--text-muted)">ค่าธงศ์ปัจจุบัน = ${CONFIG.FACE_MATCH_THRESHOLD} (แนะนำเท่านั้น ไม่ได้อัปเดต自動)</div>`;
    const now = document.getElementById('calStatus');
    if (now) now.textContent = `เสร็จสิ้น ${r.n} เฟรม`;
}
