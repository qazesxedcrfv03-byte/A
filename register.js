// register.js — เก็บ 200 ตัวอย่างใบหน้าหลากมุมเป็นชุดข้อมูล แล้วสร้างเทมเพลต compact สำหร้บันทึก
const REG_TARGET_SAMPLES  = 200;   // จำนวนตัวอย่างขั้นต่ำที่ต้องเก็บก่อนบันทึก
const REG_SAMPLE_INTERVAL_MS = 110;  // รอบการจับคู่ต่อครั้ง (หน่วย ms)
const REG_DIVERSITY_MIN = 0.08;      // ระดับการลากบ่อยขั้นต่ำก่อนยอมรับตัวอย่างใหม่ (เว้นตัวอย่างซ้ำกับขณะยังอยู่)
const REG_FACE_MIN_SIZE_RATIO = 0.10; // ใบหน้ารวมต้อง >= 10% ของเฟรม
const REG_THUMB_EVERY = 20;          // เก็บรูปตัวอย่างย่อทุก N ตัวอย่าง (เพื่อแ prev้ว)

let capturedDescriptors = []; // Float32Array[] (128) — ชุดข้อมูลต้นทาง 200 ตัวอย่าง
let capturedThumbs      = []; // dataURL ย่อ (sparse) เพื่อ preview
let capturedSamplesArr  = []; // Array[] (128) ที่พร้อมสำหรับเก็บ (JSON-ready) — เทียบกับ capturedDescriptors
let isSampling          = false;
let regProcessing       = false;
let regInterval         = null;
let lastSampleAt        = 0;
let lastStoredDesc      = null;
let pendingTemplates    = null;   // ใช้ร่วมกันกับ doSaveRegister เพื่อไม่คำนวณซ้ำ

function initRegisterUI() { resetCapture(); }

function resetCapture() {
    stopSampling();
    capturedDescriptors = [];
    capturedSamplesArr  = [];
    capturedThumbs      = [];
    pendingTemplates    = null;
    const counter = document.getElementById('sampleCounter');
    if (counter) counter.textContent = `ตัวอย่าง 0 / ${REG_TARGET_SAMPLES}`;
    const fill = document.getElementById('progressFill');
    if (fill) fill.style.width = '0%';
    const rp = document.getElementById('regProgress');
    if (rp) rp.style.display = 'none';
    const rb = document.getElementById('registerBtn');
    if (rb) rb.style.display = 'none';
    const sw = document.getElementById('regSuccessWrapper');
    if (sw) sw.style.display = 'none';
    const captureSection = document.querySelector('.capture-section');
    if (captureSection) captureSection.style.display = 'block';
    const miniCam = document.querySelector('.mini-cam-card');
    if (miniCam) miniCam.style.display = 'block';
    const btn = document.getElementById('captureBtn');
    if (btn) { btn.disabled = false; btn.textContent = '▶ เริ่มเก็บตัวอย่าง (200)'; }
    setRegInstruction('กรอกข้อมูลให้ครบ แล้วกด "เริ่มเก็บตัวอย่าง" แล้วเคลื่อนหัว: ซ้าย–ขวา / ก้ม–เงย / ขยับเข้า–ออก เบา ๆ');
    setRegGuide('↕↔ เคลื่อนที่');
    setFaceFeedback('ready', 'พร้อมเก็บตัวอย่าง');
    clearCamOverlay();
    const ellipse = document.getElementById('faceGuideEllipse');
    if (ellipse) ellipse.className = 'face-guide-ellipse';
    const thumbs = document.getElementById('sampleThumbs');
    if (thumbs) thumbs.innerHTML = '';
    const angleText = document.getElementById('currentAngleText');
    if (angleText) angleText.textContent = `📍 พร้อมเก็บตัวอยย (0 / ${REG_TARGET_SAMPLES})`;
    updateStepper();
}

function setRegInstruction(text) {
    const el = document.getElementById('captureInstruction');
    if (el) el.textContent = text;
}
function setRegGuide(text) {
    const el = document.getElementById('guideArrowText');
    if (el) el.textContent = text;
}

function setFaceFeedback(state, text) {
    const el = document.getElementById('faceFeedback');
    if (!el) return;
    el.className = 'face-feedback ' + state;
    const dot = el.querySelector('.fb-dot');
    if (dot) dot.className = 'fb-dot';
    const fbText = el.querySelector('.fb-text');
    if (fbText) fbText.textContent = text;
}
function clearCamOverlay() {
    try {
        const c = document.getElementById('canvas2');
        if (c) { const ctx = c.getContext('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height); }
    } catch (e) { /* ignore */ }
}

function captureOneFace() {
    if (!cameraActive) { showToast('⚠️ กล้ำยังไม่พร้อม กรุณารอสักครู่'); return; }
    if (isSampling) { stopSampling(); return; }
    startSampling();
}

function startSampling() {
    const name = document.getElementById('name')?.value.trim();
    const id   = document.getElementById('studentId')?.value.trim();
    const year = document.getElementById('year')?.value.trim();
    if (!name) { showToast('⚠️ กรุณากรอกชื่อ-นามสกุล'); return; }
    if (!id)   { showToast('⚠️ กรุณากรอกรหัสประจำตัว'); return; }
    if (!year) { showToast('⚠️ กรุณากรอกชั้นปี'); return; }

    isSampling = true; regProcessing = false;
    lastSampleAt = 0; lastStoredDesc = null;
    const angleText = document.getElementById('currentAngleText');
    if (angleText) angleText.textContent = `📍 กำลังเก็บตัวอยย (0 / ${REG_TARGET_SAMPLES})`;
    const btn = document.getElementById('captureBtn');
    if (btn) { btn.disabled = false; btn.textContent = '⏹ หยุม'; }
    setRegInstruction('🔄 กำลังเก็บตัวอย่างใบหน้า... หันซ้าย–ขวา / ก้ม–เงย / ขยับเข้า–ออก เบา ๆ เพื่อให้ได้มุมหลากหลาย');
    setRegGuide('↕↔ เคลื่อนที่');
    setFaceFeedback('ready', 'พร้อมเก็บตัวอย่าง');
    document.getElementById('registerBtn').style.display = 'none';
    regInterval = setInterval(registrationLoop, REG_SAMPLE_INTERVAL_MS);
    updateStepper();
}

function stopSampling() {
    isSampling = false;
    clearInterval(regInterval); regInterval = null;
    regProcessing = false;
    const btn = document.getElementById('captureBtn');
    if (btn) {
        btn.disabled = false;
        btn.textContent = capturedDescriptors.length >= REG_TARGET_SAMPLES
            ? '▶ เก็บเพิ่ม (อีกครั้ง)'
            : `▶ เริ่มเก็บตัวอย่าง (200)`;
    }
    if (capturedDescriptors.length >= REG_TARGET_SAMPLES) {
        setRegInstruction('✅ ครบ 200 ตัวอย่างแล้ว — กด "ยืนยันบันทึก" ด้านล่าง');
    } else {
        setRegInstruction(`เก็บไปแล้ว ${capturedDescriptors.length} / ${REG_TARGET_SAMPLES} ตัวอย่าง — กด "เริ่มเก็บตัวอย่าง" เพื่อเก็บเพิ่ม`);
    }
    setRegGuide('↕↔ เคลื่อนที่');
    setFaceFeedback('ready', 'พร้อมเก็บตัวอย่างเพิ่ม');
    clearCamOverlay();
}

async function registrationLoop() {
    if (!isSampling) return;
    if (regProcessing) return;
    regProcessing = true;
    try {
        const videoEl = document.getElementById('video2') || document.getElementById('video');
        if (!videoEl || videoEl.readyState < 2) return;

        const detections = await faceapi
            .detectAllFaces(videoEl, new faceapi.SsdMobilenetv1Options({ minConfidence: CONFIG.FACE_DETECT_MIN_CONFIDENCE }))
            .withFaceLandmarks()
            .withFaceDescriptors();

        const dSize   = { width: videoEl.videoWidth || 640, height: videoEl.videoHeight || 480 };
        const resized = faceapi.resizeResults(detections, dSize);

        if (resized.length === 0) {
            setFaceFeedback('error', '❌ ไม่เห็นใบหน้า — วางหน้าในกรอบ');
            setRegInstruction('🔍 หาใบหน้าไม่เจ็บ — อยู่ในกรอบและมองใบหน้าเซียน');
            setRegGuide('↕↔ เคลื่อนที่');
            clearCamOverlay();
            return;
        }
        if (resized.length > 1) {
            setFaceFeedback('warning', '⚠️ มีหลายใบหน้า — ให้มีเพียง 1 คน');
            setRegInstruction('⚠️ กรุณาให้มีใบหน้าเพียงคนเดียวในกรอบ');
            setRegGuide('↕↔ เคลื่อนที่');
            clearCamOverlay();
            return;
        }

        const detection = resized[0];
        drawRegOverlay(detection, videoEl);

        const box = detection.detection.box;
        const fw = videoEl.videoWidth  || 640;
        const fh = videoEl.videoHeight || 480;
        const frameArea = fw * fh;

        if (box.width * box.height < frameArea * REG_FACE_MIN_SIZE_RATIO) {
            setFaceFeedback('warning', '↔️ ขยับเข้าใกล้กล้ำอีกนิด');
            setRegInstruction('↔️ ขยับเข้าใกล้กล้ำยอีกนิด (ให้ใบหน้าใหญ่ขึ้น)');
            setRegGuide('↕↔ เคลื่อนที่');
            return;
        }

        setFaceFeedback('good', '✓ ใบหน้าอยู่ในที่ดี');

        const desc = detection.descriptor;
        const now  = Date.now();

        if (now - lastSampleAt < REG_SAMPLE_INTERVAL_MS) return;
        if (lastStoredDesc) {
            let skip = false;
            try { skip = faceapi.euclideanDistance(desc, lastStoredDesc) < REG_DIVERSITY_MIN; } catch (e) { skip = false; }
            if (skip) return;
        }

        capturedDescriptors.push(desc);
        capturedSamplesArr.push(Array.from(desc));
        lastStoredDesc = desc;
        lastSampleAt   = now;

        if (capturedDescriptors.length % REG_THUMB_EVERY === 0) {
            capturedThumbs.push(cropFaceThumb(detection, videoEl));
        }
        updateRegProgress();

        if (capturedDescriptors.length >= REG_TARGET_SAMPLES) {
            stopSampling();
        }
    } catch (err) {
        console.error('registrationLoop error:', err);
    } finally {
        regProcessing = false;
    }
}

function drawRegOverlay(detection, videoEl) {
    try {
        const canvas = document.getElementById('canvas2');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        faceapi.matchDimensions(canvas, { width: videoEl.videoWidth || 640, height: videoEl.videoHeight || 480 });
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!detection) {
            setFaceFeedback('error', '❌ ไม่เห็นใบหน้า — วางหน้าในกรอบ');
            return;
        }

        const box = detection.detection.box;
        const fw = videoEl.videoWidth  || 640;
        const fh = videoEl.videoHeight || 480;
        const ok = (box.width * box.height) >= fw * fh * REG_FACE_MIN_SIZE_RATIO;
        const color = ok ? '#22c55e' : '#f59e0b';

        const ellipse = document.getElementById('faceGuideEllipse');
        if (ellipse) ellipse.className = 'face-guide-ellipse ' + (ok ? 'good' : 'warning');

        ctx.save();
        ctx.scale(-1, 1);
        ctx.translate(-canvas.width, 0);
        ctx.strokeStyle = color;
        ctx.lineWidth   = 3;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.rect(canvas.width - (box.x + box.width), box.y, box.width, box.height);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    } catch (e) { /* ignore canvas errors */ }
}

function cropFaceThumb(detection, videoEl) {
    try {
        const box    = detection.detection.box;
        const pad    = 16;
        const sx     = Math.max(0, box.x - pad);
        const sy     = Math.max(0, box.y - pad);
        const sw     = Math.min(box.width  + pad * 2, (videoEl.videoWidth  || 640) - sx);
        const sh     = Math.min(box.height + pad * 2, (videoEl.videoHeight || 480) - sy);
        const c      = document.createElement('canvas');
        c.width = 70; c.height = 70;
        const ctx = c.getContext('2d');
        ctx.save(); ctx.scale(-1, 1); ctx.translate(-70, 0);   // กล้ำยเป็น mirror
        ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, 70, 70);
        ctx.restore();
        return c.toDataURL('image/jpeg', 0.8);
    } catch { return ''; }
}

function updateRegProgress() {
    const n = capturedDescriptors.length;
    const pct = Math.min(100, Math.round(n / REG_TARGET_SAMPLES * 100));
    const counter = document.getElementById('sampleCounter');
    if (counter) counter.textContent = `ตัวอย่าง ${n} / ${REG_TARGET_SAMPLES}`;
    const fill = document.getElementById('progressFill');
    if (fill) fill.style.width = pct + '%';
    const rp = document.getElementById('regProgress');
    if (rp) rp.style.display = 'block';
    const rs = document.getElementById('reg-status');
    if (rs) rs.textContent = `กำลังเก็บตัวอย่าง... ${n} / ${REG_TARGET_SAMPLES}`;
    const angleText = document.getElementById('currentAngleText');
    if (angleText) angleText.textContent = `📍 ตัวอย่าง ${n} / ${REG_TARGET_SAMPLES}`;
    const rb = document.getElementById('registerBtn');
    if (rb) rb.style.display = (n >= REG_TARGET_SAMPLES) ? 'flex' : 'none';
    const thumbs = document.getElementById('sampleThumbs');
    if (thumbs) thumbs.innerHTML = capturedThumbs.slice(-8).map(u => `<img src="${u}" class="sample-thumb" alt="ตัวอย่าง">`).join('');
}

// สร้างเทมเพลต compact (CONFIG.FACE_TEMPLATE_COUNT รายการ) จากชุดข้อมูล 200 ตัวอย่าง
// ขั้นตอน: (1) กรองตัวอย่างผิดคลื่น (outlier) จากเมตริกซ้ำ่วย centroid, (2) greedy k-center
// (max-min diversification) เลือกเทมเพลตหลากมุมและไม่ซ้ำกัน
function selectTemplates(samples, k) {
    const n = samples.length;
    const K = Math.min(k, n);
    if (n === 0) return [];
    if (n <= K) return samples.map(s => Array.from(s));

    const dim = samples[0].length; // 128
    const centroid = new Float32Array(dim);
    for (const s of samples) {
        for (let i = 0; i < dim; i++) centroid[i] += s[i];
    }
    for (let i = 0; i < dim; i++) centroid[i] /= n;

    const dists = samples.map(s => faceapi.euclideanDistance(centroid, s));
    const med = median(dists);
    const mad = median(dists.map(d => Math.abs(d - med))) || 0;
    const sigma = 1.4826 * mad;
    const meanDist = dists.reduce((a, b) => a + b, 0) / n;
    const outlierThresh = Math.max(med + 3 * sigma, meanDist * 1.5, med + 0.3);
    let pool = samples.filter((_, i) => dists[i] <= outlierThresh);
    if (pool.length < Math.max(K, 8)) pool = samples.slice();

    let first = 0, best = Infinity;
    for (let i = 0; i < pool.length; i++) {
        const d = faceapi.euclideanDistance(centroid, pool[i]);
        if (d < best) { best = d; first = i; }
    }
    const picked = [first];
    const minD = new Array(pool.length);
    for (let i = 0; i < pool.length; i++) minD[i] = faceapi.euclideanDistance(pool[i], pool[first]);

    for (let sel = 1; sel < K; sel++) {
        let farIdx = -1, farVal = -1;
        for (let i = 0; i < pool.length; i++) {
            if (minD[i] > farVal) { farVal = minD[i]; farIdx = i; }
        }
        if (farIdx === -1) break;
        picked.push(farIdx);
        for (let i = 0; i < pool.length; i++) {
            const d = faceapi.euclideanDistance(pool[i], pool[farIdx]);
            if (d < minD[i]) minD[i] = d;
        }
    }
    return picked.map(i => Array.from(pool[i]));
}

function median(arr) {
    const a = arr.slice().sort((x, y) => x - y);
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function updateStepper() {
    const name = document.getElementById('name')?.value.trim();
    const id   = document.getElementById('studentId')?.value.trim();
    const year = document.getElementById('year')?.value.trim();
    const infoComplete    = !!(name && id && year);
    const samplingStarted = capturedDescriptors.length > 0;
    const samplingDone    = capturedDescriptors.length >= REG_TARGET_SAMPLES;

    let active = 1;
    if (samplingDone)    active = 4;   // รอยยืนยัน (review)
    else if (samplingStarted) active = 3; // เก็บตัวอย่าง
    else if (infoComplete)  active = 2;  // เตรียมกล้ำย

    for (let i = 1; i <= 5; i++) {
        const el = document.getElementById('step' + i);
        if (!el) continue;
        el.classList.remove('active', 'done');
        if (i < active) el.classList.add('done');
        else if (i === active) el.classList.add('active');
    }
}

function setStepperComplete() {
    for (let i = 1; i <= 5; i++) {
        const el = document.getElementById('step' + i);
        if (!el) continue;
        el.classList.remove('active');
        el.classList.add('done');
    }
    document.getElementById('step5')?.classList.add('active');
}

function openConfirmRegister() {
    const nameInput = document.getElementById('name');
    const idInput   = document.getElementById('studentId');
    const yearInput = document.getElementById('year');

    const name = nameInput?.value.trim();
    const id   = idInput?.value.trim();
    const year = yearInput?.value.trim();

    if (!name) { showToast('⚠️ กรุณากรอกชื่อ-นามสกุล'); return; }
    if (!id)   { showToast('⚠️ กรุณากรอกรหัสประจำตัว'); return; }
    if (!year) { showToast('⚠️ กรุณากรอกชั้นปี'); return; }
    if (capturedDescriptors.length < REG_TARGET_SAMPLES) {
        showToast(`⚠️ กรุณาเก็บอย่างน้อย ${REG_TARGET_SAMPLES} ตัวอย่างใบหน้า`);
        return;
    }

    const dupId   = DataStore.findStudentById(id);
    if (dupId) { showToast(`❌ รหัส "${id}" มีในระบบแล้ว (${dupId.name})`); return; }

    const dupName = DataStore.findStudentByName(name);
    if (dupName && dupName.id !== id) {
        if (!confirm(`⚠️ ชื่อ "${name}" มีในระบบแล้ว (รหัส ${dupName.id}) ยืนยันเพิ่มอีกคนหรือไม่?`)) return;
    }

    // สร้างเทมเพลตจากชุดข้อมูล 200 ตัวอย่าง (ใช้เท่านั้นสำหรับตรวจใบหน้าซ้ำ)
    pendingTemplates = selectTemplates(capturedDescriptors, CONFIG.FACE_TEMPLATE_COUNT);

    // ตรวจใบหน้าซ้ำ: เทมเพลตใหม่กับใบหน้าทั้งหมดที่มีอยู่แล้ว
    const dupThresh = CONFIG.FACE_MATCH_THRESHOLD * 0.8;
    let dupFace = null;
    if (registeredFaces.length > 0 && pendingTemplates.length > 0) {
        outer:
        for (const student of DataStore.getStudents()) {
            if (!student.descriptors || student.descriptors.length === 0) continue;
            if (student.id === id) continue;
            for (const t of pendingTemplates) {
                const nt = new Float32Array(t);
                for (const exd of student.descriptors) {
                    try {
                        if (faceapi.euclideanDistance(nt, new Float32Array(exd)) < dupThresh) {
                            dupFace = student; break outer;
                        }
                    } catch (e) { /* skip malformed */ }
                }
            }
        }
    }
    if (dupFace) {
        if (!confirm(`⚠️ ใบหน้านี้อาจใกล้เคียงกับ "${dupFace.name}" (รหัส ${dupFace.id}) แล้ว ในระบบ ยืนยันเพิ่มใช่หรือไม่?`)) return;
    }

    // แสดงหน้าต่อยงการยืนยัน (ใช้ escapeHtml เฉพาะการแสดง)
    const info   = document.getElementById('confirmInfo');
    const thumbs = document.getElementById('confirmThumbs');
    if (info) info.innerHTML = `
        <div>👤 <b>ชื่อ:</b> ${escapeHtml(name)}</div>
        <div>🪪 <b>รหัส:</b> ${escapeHtml(id)}</div>
        <div>🎓 <b>ชั้นปี:</b> ${escapeHtml(year)}</div>
        <div>📸 <b>ตัวอย่างใบหน้าที่เก็บ:</b> ${capturedDescriptors.length} ตัวอย่าง</div>
        <div>🧬 <b>เทมเพลตที่ใช้จัดการ:</b> ${pendingTemplates.length} เทมเพลต (สรุปจาก ${REG_TARGET_SAMPLES} ตัวอย่างโดยเลือกตัวแทนย่อย่อน + หลีกเลี่ยงซ้ำ)</div>`;
    if (thumbs) thumbs.innerHTML = capturedThumbs.map(u => `<img src="${u}" alt="thumb">`).join('');
    openModal('confirmRegisterModal');
}

function doSaveRegister() {
    const nameInput = document.getElementById('name');
    const idInput   = document.getElementById('studentId');
    const yearInput = document.getElementById('year');

    const name = nameInput?.value.trim();
    const id   = idInput?.value.trim();
    const year = yearInput?.value.trim();

    const btn = document.getElementById('registerBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ กำลังบันทึก...'; }

    try {
        const templates = pendingTemplates || selectTemplates(capturedDescriptors, CONFIG.FACE_TEMPLATE_COUNT);

        // เก็บทั้งหมด: descriptors = เทมเพลต compact (ใช้จริงโดย recognizer อย่างไม่แต่งงาน)
        //                samples  = ชุดข้อมูลต้นทาง 200 ตัวอย่าง (เป็นแหล่งข้อมูลสำหรับสร้างเทมเพลต)
        const student = {
            name,
            id,
            year,
            descriptors: templates,             // Array[128] x 20 — ใช้โดย FaceMatcher (scan.js ไม่ถูกแตะ)
            samples: capturedSamplesArr         // Array[128] x 200 — ชุดข้อมูลต้นทาง (เก็บแต่ไม่ใช้ตรงใน recognition นี้)
        };
        const ok = DataStore.addStudent(student);
        if (!ok) {
            if (btn) { btn.disabled = false; btn.textContent = '✅ ยืนยันบันทึกข้อมูล'; }
            showToast('❌ เก็บข้อมูลใบหน้าไม่สำเร็จ (พื้นที่เต็ม) กรุณาลบนักศึกษาเก่า ๆ แล้วลองอีกครั้ง');
            return;
        }
        if (typeof syncStudentRegistration === 'function') syncStudentRegistration(student);
        registeredFaces = DataStore.getStudents();
        updateStats();

        closeModal('confirmRegisterModal');
        showToast(`✅ ลงทะเบียน "${name}" สำเร็จ! (เก็บ ${capturedDescriptors.length} ตัวอย่าง → ${templates.length} เทมเพลต)`);
        setStepperComplete();

        const successWrapper = document.getElementById('regSuccessWrapper');
        const successName = document.getElementById('regSuccessName');
        const successId = document.getElementById('regSuccessId');
        const successSamples = document.querySelector('.reg-success-samples');
        if (successName) successName.textContent = name;
        if (successId) successId.textContent = `รหัส ${id}`;
        if (successSamples) successSamples.textContent = `ตัวอย่างใบหน้า: ${capturedDescriptors.length} ราย / เทมเพลต: ${templates.length} เทมเพลต`;
        if (successWrapper) successWrapper.style.display = 'block';

        setTimeout(() => {
            const regProgress = document.getElementById('regProgress');
            if (regProgress) regProgress.style.display = 'none';
            const captureSection = document.querySelector('.capture-section');
            if (captureSection) captureSection.style.display = 'none';
            const miniCam = document.querySelector('.mini-cam-card');
            if (miniCam) miniCam.style.display = 'none';
        }, 500);

        setTimeout(() => {
            if (nameInput) nameInput.value = '';
            if (idInput)   idInput.value   = '';
            if (yearInput) yearInput.value = '';
            resetCapture();
        }, 3500);
    } catch (err) {
        console.error('doSaveRegister error:', err);
        showToast('❌ ไม่สามารถบันทึกข้อมูลได้');
        if (btn) { btn.disabled = false; btn.textContent = '✅ ยืนยันบันทึกข้อมูล'; }
    }
}
