// leave.js — ระบบแจ้งลา (มีสถานะ รออนุมัติ/อนุมัติ/ไม่อนุมัติ)
// Business logic preserved from Kilo's original leave system.

function autoFillLeaveInfo() {
    const sid  = document.getElementById('leaveStudentId').value.trim();
    const student = DataStore.findStudentById(sid);
    document.getElementById('leaveName').value = student ? student.name : '';
    document.getElementById('leaveYear').value = student ? (student.year||'') : '';
}

function submitLeave() {
    const sidInput = document.getElementById('leaveStudentId');
    const nameInput = document.getElementById('leaveName');
    const yearInput = document.getElementById('leaveYear');
    const reasonInput = document.getElementById('leaveReason');

    const sid = sidInput.value.trim();
    const name = nameInput.value.trim();
    const year = yearInput.value.trim();
    const date = document.getElementById('leaveDate').value;
    const type = document.getElementById('leaveType').value;
    const reason = reasonInput.value.trim();

    if (!sid)    { showToast('⚠️ กรุณากรอกรหัสนักศึกษา'); return; }
    if (!name)   { showToast('⚠️ ไม่พบรหัสนี้ในระบบ'); return; }
    if (!date)   { showToast('⚠️ กรุณาเลือกวันที่ลา'); return; }
    if (!reason) { showToast('⚠️ กรุณาระบุเหตุผล'); return; }

    // เช็คว่าลาวันเดิมซ้ำแล้วหรือยัง
    const dup = DataStore.getLeaves().find(r => r.studentId === sid && r.date === date);
    if (dup) { showToast(`⚠️ ${name} แจ้งลาวันที่ ${date} ไปแล้ว`); return; }

    const leave = { studentId:sid, name, year, date, type, reason, status:'pending', timestamp: Date.now() };
    DataStore.addLeave(leave);
    leaveList = DataStore.getLeaves();
    renderLeaveTable();
    showToast(`📝 บันทึกใบลา "${name}" สำเร็จ! รออาจารย์อนุมัติ`);

    // reset form
    document.getElementById('leaveStudentId').value = '';
    document.getElementById('leaveName').value = '';
    document.getElementById('leaveYear').value = '';
    document.getElementById('leaveReason').value = '';
    document.getElementById('leaveDate').value = DateHelper.today();
}

function populateLeaveFilters() {
    const classes = getClassList();
    const opts = '<option value="all">ทุกชั้นปี</option>' + classes.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    const sel = document.getElementById('leaveClassFilter');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = opts;
    if (classes.includes(cur) || cur === 'all') sel.value = cur;
}

function renderLeaveTable() {
    const tbody  = document.getElementById('leaveBody');
    const empty  = document.getElementById('leaveEmpty');
    const cardsWrap = document.getElementById('leaveCardsMobile');
    if (!tbody) return;

    // Apply filters: search, date, class, type, status
    const search   = (document.getElementById('leaveSearch')?.value || '').toLowerCase();
    const dateVal  = document.getElementById('leaveDateFilter')?.value || '';
    const classF   = document.getElementById('leaveClassFilter')?.value || 'all';
    const typeF    = document.getElementById('leaveTypeFilter')?.value || 'all';
    const statusF  = document.getElementById('leaveStatusFilter')?.value || 'all';

    let list = leaveList;
    if (search)   list = list.filter(r => r.name.toLowerCase().includes(search) || (r.studentId||'').toLowerCase().includes(search));
    if (dateVal)  list = list.filter(r => r.date === dateVal);
    if (classF !== 'all')    list = list.filter(r => (r.year||'—') === classF);
    if (typeF !== 'all')     list = list.filter(r => r.type === typeF);
    if (statusF !== 'all')   list = list.filter(r => (r.status || 'pending') === statusF);

    if (list.length === 0) {
        tbody.innerHTML = '';
        if (cardsWrap) cardsWrap.innerHTML = '';
        if (empty) empty.style.display = 'block';
        return;
    }
    if (empty) empty.style.display = 'none';

    const typeBadgeClass = { 'ลาป่วย':'badge-sick', 'ลากิจ':'badge-personal', 'ลาพักร้อน':'badge-vacation', 'อื่นๆ':'badge-other' };
    const statusBadge = { pending: ['badge-pending','⏳ รออนุมัติ'], approved: ['badge-approved','✓ อนุมัติแล้ว'], rejected: ['badge-rejected','✕ ไม่อนุมัติ'] };

    tbody.innerHTML = list.slice().reverse().map((r, i) => {
        const actualIndex = leaveList.indexOf(r);
        const status = r.status || 'pending';
        const [sCls, sLbl] = statusBadge[status] || statusBadge.pending;
        const tCls = typeBadgeClass[r.type] || 'badge-other';
        const actions = isAdminSession
            ? (status === 'pending'
                ? `<div class="leave-approve-actions">
                        <button class="btn-approve" onclick="approveLeave(${actualIndex})">✓ อนุมัติ</button>
                        <button class="btn-reject" onclick="rejectLeave(${actualIndex})">✕ ไม่อนุมัติ</button>
                        <button class="btn-del" onclick="deleteLeave(${actualIndex})">🗑️</button>
                   </div>`
                : `<div class="leave-approve-actions">
                        <button class="btn-del" onclick="deleteLeave(${actualIndex})">🗑️</button>
                   </div>`)
            : `<span style="color:var(--text-muted);font-size:0.75rem;">—</span>`;
        return `
        <tr>
            <td style="color:var(--text-muted);font-family:var(--font-mono)">${i+1}</td>
            <td>
                <div style="display:flex;align-items:center;gap:8px;">
                    <span class="leave-row-avatar">${escapeHtml((r.name||'?').trim().charAt(0))}</span>
                    <div>
                        <div style="font-weight:600">${escapeHtml(r.name)}</div>
                        <div style="font-family:var(--font-mono);font-size:0.78rem;color:var(--text-muted)">${escapeHtml(r.studentId||'—')}</div>
                    </div>
                </div>
            </td>
            <td>${escapeHtml(r.year||'—')}</td>
            <td><span class="badge ${tCls}">${escapeHtml(r.type)}</span></td>
            <td style="font-family:var(--font-mono)">${escapeHtml(r.date)}</td>
            <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.8rem;color:var(--text-secondary)">${escapeHtml(r.reason||'—')}</td>
            <td><span class="badge ${sCls}">${sLbl}</span></td>
            <td>${actions}</td>
        </tr>`;
    }).join('');

    // Mobile cards
    if (cardsWrap) {
        cardsWrap.innerHTML = list.slice().reverse().map((r, i) => {
            const actualIndex = leaveList.indexOf(r);
            const status = r.status || 'pending';
            const [sCls, sLbl] = statusBadge[status] || statusBadge.pending;
            const tCls = typeBadgeClass[r.type] || 'badge-other';
            let actionsHtml;
            if (isAdminSession) {
                actionsHtml = (status === 'pending'
                    ? `<div class="leave-approve-actions">
                            <button class="btn-approve" onclick="approveLeave(${actualIndex})">✓ อนุมัติ</button>
                            <button class="btn-reject" onclick="rejectLeave(${actualIndex})">✕ ไม่อนุมัติ</button>
                            <button class="btn-del" onclick="deleteLeave(${actualIndex})">🗑️</button>
                       </div>`
                    : `<button class="btn-del" onclick="deleteLeave(${actualIndex})">🗑️</button>`);
            } else {
                actionsHtml = `<span style="color:var(--text-muted);font-size:0.75rem;">—</span>`;
            }
            return `
            <div class="leave-card-mobile">
                <div class="leave-card-row">
                    <span class="leave-card-label">นักศึกษา</span>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span class="leave-row-avatar">${escapeHtml((r.name||'?').trim().charAt(0))}</span>
                        <span style="font-weight:600">${escapeHtml(r.name)}</span>
                    </div>
                </div>
                <div class="leave-card-row"><span class="leave-card-label">รหัส</span><span style="font-family:var(--font-mono)">${escapeHtml(r.studentId||'—')}</span></div>
                <div class="leave-card-row"><span class="leave-card-label">ชั้นปี</span>${escapeHtml(r.year||'—')}</div>
                <div class="leave-card-row"><span class="leave-card-label">ประเภท</span><span class="badge ${tCls}">${escapeHtml(r.type)}</span></div>
                <div class="leave-card-row"><span class="leave-card-label">วันที่</span><span style="font-family:var(--font-mono)">${escapeHtml(r.date)}</span></div>
                <div class="leave-card-row"><span class="leave-card-label">เหตุผล</span>${escapeHtml(r.reason||'—')}</div>
                <div class="leave-card-row"><span class="leave-card-label">สถานะ</span><span class="badge ${sCls}">${sLbl}</span></div>
                <div class="leave-card-row" style="justify-content:flex-end;">${actionsHtml}</div>
            </div>`;
        }).join('');
    }
}

function deleteLeave(i) {
    if (!confirm(`ลบรายการลาของ "${leaveList[i].name}" วันที่ ${leaveList[i].date}?`)) return;
    DataStore.removeLeave(i);
    leaveList = DataStore.getLeaves();
    renderLeaveTable();
    if (typeof renderDashboard === 'function' && document.getElementById('section-dashboard')?.classList.contains('active')) renderDashboard();
    showToast('🗑️ ลบรายการลาแล้ว');
}

// อนุมัติ/ไม่อนุมัติใบลา — เฉพาะอาจารย์ที่ล็อกอินแล้วในเซสชันนี้ (isAdminSession, กำหนดใน app.js)
function approveLeave(i) {
    if (!isAdminSession) { showToast('⚠️ กรุณาล็อกอินอาจารย์ก่อน'); return; }
    if (!leaveList[i]) return;
    DataStore.setLeaveStatus(i, 'approved');
    leaveList = DataStore.getLeaves();
    renderLeaveTable();
    if (typeof renderDashboard === 'function' && document.getElementById('section-dashboard')?.classList.contains('active')) renderDashboard();
    if (typeof renderAttendanceTable === 'function' && document.getElementById('section-attendance')?.classList.contains('active')) renderAttendanceTable();
    showToast(`✅ อนุมัติใบลาของ "${leaveList[i].name}" แล้ว`);
}

function rejectLeave(i) {
    if (!isAdminSession) { showToast('⚠️ กรุณาล็อกอินอาจารย์ก่อน'); return; }
    if (!leaveList[i]) return;
    DataStore.setLeaveStatus(i, 'rejected');
    leaveList = DataStore.getLeaves();
    renderLeaveTable();
    if (typeof renderDashboard === 'function' && document.getElementById('section-dashboard')?.classList.contains('active')) renderDashboard();
    if (typeof renderAttendanceTable === 'function' && document.getElementById('section-attendance')?.classList.contains('active')) renderAttendanceTable();
    showToast(`❌ ไม่อนุมัติใบลาของ "${leaveList[i].name}"`);
}
