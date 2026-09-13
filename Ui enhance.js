// ui-enhance.js — ADDITIVE ONLY.
// Adds a dark/light theme toggle and a Cmd/Ctrl+K command palette on top of
// the existing app. Does not touch, redefine, or depend on the internals of
// app.js / scan.js / register.js / leave.js — it only calls the one function
// they already expose globally: showSection(name). Safe to include or remove
// at any time; nothing else in the app references this file.
//
// Include AFTER all other scripts, right before </body>:
//   <script src="ui-enhance.js"></script>
(function () {
    'use strict';

    var THEME_KEY = 'fg_theme'; // 'dark' | 'light'
    var SECTIONS = [
        { id: 'dashboard', icon: '⌂', label: 'แดชบอร์ด' },
        { id: 'scan',      icon: '⬡', label: 'สแกนใบหน้า' },
        { id: 'register',  icon: '＋', label: 'ลงทะเบียนใบหน้า' },
        { id: 'database',  icon: '⊞', label: 'นักศึกษา' },
        { id: 'attendance',icon: '≡', label: 'เข้าแถว' },
        { id: 'leave',     icon: '📝', label: 'แจ้งลา' },
        { id: 'reports',   icon: '📊', label: 'รายงาน' },
        { id: 'settings',  icon: '⚙', label: 'ตั้งค่า' },
    ];

    // ── Theme ──
    function applyTheme(theme) {
        if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
        else document.documentElement.removeAttribute('data-theme');
        var btn = document.getElementById('themeToggleBtn');
        if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀️';
    }
    function initTheme() {
        var saved = null;
        try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
        applyTheme(saved === 'light' ? 'light' : 'dark');
    }
    function toggleTheme() {
        var isLight = document.documentElement.getAttribute('data-theme') === 'light';
        var next = isLight ? 'dark' : 'light';
        applyTheme(next);
        try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    }
    function mountThemeToggle() {
        var host = document.querySelector('.topbar-right');
        if (!host || document.getElementById('themeToggleBtn')) return;
        var btn = document.createElement('button');
        btn.id = 'themeToggleBtn';
        btn.type = 'button';
        btn.className = 'theme-toggle-btn';
        btn.setAttribute('aria-label', 'สลับโหมดสี');
        btn.title = 'สลับโหมดมืด/สว่าง';
        btn.textContent = '☀️';
        btn.addEventListener('click', toggleTheme);
        host.insertBefore(btn, host.firstChild);
    }

    // ── Command palette ──
    var paletteEl = null, inputEl = null, listEl = null, activeIndex = 0, filtered = SECTIONS.slice();

    function buildPalette() {
        if (paletteEl) return;
        paletteEl = document.createElement('div');
        paletteEl.className = 'cmdk-overlay';
        paletteEl.id = 'cmdkOverlay';
        paletteEl.innerHTML =
            '<div class="cmdk-box" role="dialog" aria-modal="true" aria-label="ค้นหาเมนูด่วน">' +
              '<div class="cmdk-input-row">' +
                '<span aria-hidden="true">⌘K</span>' +
                '<input class="cmdk-input" id="cmdkInput" type="text" placeholder="ไปที่เมนู... (พิมพ์เพื่อค้นหา)" autocomplete="off" />' +
                '<span class="cmdk-hint">Esc</span>' +
              '</div>' +
              '<div class="cmdk-list" id="cmdkList"></div>' +
            '</div>';
        document.body.appendChild(paletteEl);
        inputEl = document.getElementById('cmdkInput');
        listEl = document.getElementById('cmdkList');

        paletteEl.addEventListener('click', function (e) { if (e.target === paletteEl) closePalette(); });
        inputEl.addEventListener('input', function () { filterItems(inputEl.value); });
        inputEl.addEventListener('keydown', onPaletteKeydown);
    }

    function renderList() {
        if (!listEl) return;
        if (filtered.length === 0) {
            listEl.innerHTML = '<div class="cmdk-empty">ไม่พบเมนูที่ตรงกัน</div>';
            return;
        }
        listEl.innerHTML = filtered.map(function (s, i) {
            return '<div class="cmdk-item' + (i === activeIndex ? ' active' : '') + '" data-id="' + s.id + '" data-idx="' + i + '">' +
                '<span class="cmdk-icon" aria-hidden="true">' + s.icon + '</span><span>' + s.label + '</span></div>';
        }).join('');
        Array.prototype.forEach.call(listEl.querySelectorAll('.cmdk-item'), function (el) {
            el.addEventListener('click', function () { goTo(el.getAttribute('data-id')); });
        });
    }

    function filterItems(q) {
        var query = (q || '').trim().toLowerCase();
        filtered = !query ? SECTIONS.slice() : SECTIONS.filter(function (s) {
            return s.label.toLowerCase().indexOf(query) !== -1 || s.id.toLowerCase().indexOf(query) !== -1;
        });
        activeIndex = 0;
        renderList();
    }

    function onPaletteKeydown(e) {
        if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, filtered.length - 1); renderList(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); renderList(); return; }
        if (e.key === 'Enter') { e.preventDefault(); if (filtered[activeIndex]) goTo(filtered[activeIndex].id); }
    }

    function goTo(sectionId) {
        closePalette();
        if (typeof window.showSection === 'function') window.showSection(sectionId);
    }

    function openPalette() {
        buildPalette();
        filtered = SECTIONS.slice();
        activeIndex = 0;
        renderList();
        paletteEl.classList.add('open');
        setTimeout(function () { inputEl.value = ''; inputEl.focus(); }, 10);
    }
    function closePalette() {
        if (paletteEl) paletteEl.classList.remove('open');
    }

    // ── Global shortcut ──
    document.addEventListener('keydown', function (e) {
        var isCmdK = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
        if (isCmdK) { e.preventDefault(); openPalette(); }
    });

    function init() {
        initTheme();
        mountThemeToggle();
        buildPalette();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();