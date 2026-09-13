// chatbot.js
function sendMessage() {
    const input = document.getElementById('chatInput');
    const text  = input.value.trim();
    if (!text) return;
    // Use textContent for user message to prevent XSS
    const msgs = document.getElementById('chat-messages');
    const userDiv = document.createElement('div');
    const userText = document.createElement('div');
    userText.className = 'user-msg';
    userText.textContent = text;
    userDiv.appendChild(userText);
    msgs.appendChild(userDiv);
    msgs.scrollTop = msgs.scrollHeight;
    input.value = '';
    setTimeout(() => {
        const res = getBotResponse(text);
        appendChat(res, 'bot-msg');
    }, 400);
}
function getBotResponse(text) {
    const today = DateHelper.today();
    if (/ยอด|กี่คน|จำนวน/.test(text)) {
        const attended = DataStore.getTodayAttendance().length;
        const total = DataStore.getStudents().length;
        return `📊 วันนี้เข้าแถวแล้ว ${attended} คน จากทั้งหมด ${total} คนครับ!`;
    }
    if (/ลา|ขาด/.test(text)) {
        const todayLeaves = DataStore.getTodayLeaves().length;
        const totalLeaves = DataStore.getLeaves().length;
        if (todayLeaves > 0) {
            return `📝 วันนี้มีรายการลา ${todayLeaves} คน (รวมทั้งหมด ${totalLeaves} รายการ) ดูได้ที่เมนู "แจ้งลา" เลยครับ!`;
        }
        return `📝 วันนี้ยังไม่มีรายการลา (รวมทั้งหมด ${totalLeaves} รายการ) ดูได้ที่เมนู "แจ้งลา" เลยครับ!`;
    }
    if (/สาย|สายหน้า/.test(text)) {
        const todayList = DataStore.getTodayAttendance();
        const lateCount = todayList.filter(r => DateHelper.isLate(r.time)).length;
        return `⏰ วันนี้มาสาย ${lateCount} คน จากทั้งหมด ${todayList.length} คนครับ`;
    }
    if (/ตรง/.test(text)) {
        const todayList = DataStore.getTodayAttendance();
        const onTime = todayList.filter(r => !DateHelper.isLate(r.time)).length;
        return `✓ วันนี้ตรงเวลา ${onTime} คน จากทั้งหมด ${todayList.length} คนครับ`;
    }
    if (/ยัง|ไม่มา|ขาด/.test(text)) {
        const total = DataStore.getStudents().length;
        const todayList = DataStore.getTodayAttendance();
        const todayCount = todayList.length;
        const leaveToday = DataStore.getTodayLeaves();
        const presentIds = new Set(todayList.map(r => r.studentId));
        const leaveIds = new Set(leaveToday.map(r => r.studentId));
        const absent = registeredFaces.filter(s => !presentIds.has(s.id) && !leaveIds.has(s.id)).length;
        return `📋 ขาด/ยังไม่ได้เช็กชื่อ ${absent} คน (เช็กแล้ว ${todayCount} จาก ${total} คน, ลา ${leaveToday.length} คน) ครับ`;
    }
    for (const key in botResponses) {
        if (text.includes(key)) return botResponses[key].text;
    }
    return 'น้องแคนไม่เข้าใจครับ 🐘 ลองถามชื่อวัน เช่น "วันจันทร์ใส่อะไร?" หรือ "วันนี้กี่คนเข้าแถว?" ได้เลยครับ!';
}
function appendChat(text, cls) {
    const msgs = document.getElementById('chat-messages');
    const div  = document.createElement('div');
    const innerDiv = document.createElement('div');
    innerDiv.className = cls;
    // Bot responses may contain safe HTML tags (e.g. <b> from keywords.js)
    innerDiv.innerHTML = sanitizeHtml(text);
    div.appendChild(innerDiv);
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
}
function handleChat(e) { if (e.key === 'Enter') sendMessage(); }
function toggleChatbot() {
    const body  = document.getElementById('chatbotBody');
    const arrow = document.getElementById('chatArrow');
    const isOpen = body.classList.contains('visible');
    body.classList.toggle('visible', !isOpen);
    if (arrow) arrow.classList.toggle('open', !isOpen);
}
