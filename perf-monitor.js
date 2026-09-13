// perf-monitor.js — Lightweight performance measurement for the face recognition pipeline.
// Zero external dependencies. Works in browser (global `PM`) and Node.js (module.exports).
// Debug mode is toggled via localStorage key 'fg_debug_perf' or PM.toggle().
// Production UI is unaffected: the debug panel is hidden by default and metrics
// are only computed/updated when debug mode is enabled (negligible overhead when off —
// a single boolean check per instrumented call site).
(function () {
    'use strict';

    var root = (typeof window !== 'undefined') ? window : (typeof global !== 'undefined' ? global : {});
    var STORAGE_KEY = 'fg_debug_perf';
    var HISTORY_LIMIT = 60;

    var PM = {
        enabled: false,
        metrics: {},
        _history: {},
        _frameCount: 0,
        _lastFpsUpdate: 0,
        _fps: 0,
    };

    // ── Initialization ──
    try {
        PM.enabled = (localStorage.getItem(STORAGE_KEY) === '1');
    } catch (e) { PM.enabled = false; }

    // ── Public API ──

    // High-resolution timestamp (ms).
    PM.now = function () {
        if (typeof performance !== 'undefined' && performance.now) return performance.now();
        return Date.now ? Date.now() : 0;
    };

    PM.isEnabled = function () { return this.enabled; };

    // Toggle debug mode on/off. Persists to localStorage.
    PM.toggle = function () {
        this.enabled = !this.enabled;
        try { localStorage.setItem(STORAGE_KEY, this.enabled ? '1' : '0'); } catch (e) {}
        this.updatePanelVisibility();
        if (this.enabled) this.renderPanel();
        return this.enabled;
    };

    // Record a named metric. Keeps a rolling history (max HISTORY_LIMIT) for averaging.
    PM.set = function (key, value) {
        this.metrics[key] = value;
        var h = this._history[key];
        if (!h) { h = []; this._history[key] = h; }
        h.push(value);
        if (h.length > HISTORY_LIMIT) h.shift();
        if (this.enabled) this.renderPanel();
    };

    // Reset per-frame metrics (call at the start of each scan iteration).
    PM.resetFrame = function () {
        this.metrics.inferenceMs = 0;
        this.metrics.matchingMs = 0;
        this.metrics.totalMs = 0;
        this.metrics.faceCount = 0;
        this.metrics.comparisons = 0;
        this.metrics.candidates = 0;
    };

    // Rolling average of a metric.
    PM.avg = function (key) {
        var h = this._history[key];
        if (!h || h.length === 0) return 0;
        var sum = 0;
        for (var i = 0; i < h.length; i++) sum += h[i];
        return sum / h.length;
    };

    // FPS tracking — call once per frame processed.
    PM.tick = function () {
        var t = this.now();
        this._frameCount++;
        if (t - this._lastFpsUpdate >= 1000) {
            this._fps = Math.round((this._frameCount / (t - this._lastFpsUpdate)) * 1000);
            this._frameCount = 0;
            this._lastFpsUpdate = t;
            this.set('fps', this._fps);
        }
    };

    // ── Debug panel (browser only) ──

    PM.renderPanel = function () {
        if (typeof document === 'undefined') return;
        var el = document.getElementById('perfDebugPanel');
        if (!el) return;
        var m = this.metrics;
        var fmt = function (v) {
            return (typeof v === 'number') ? v.toFixed(1) : (v || 0);
        };
        var html = '';
        html += '<div class="pm-row"><span class="pm-label">Inference</span><span class="pm-val">' + fmt(m.inferenceMs) + ' ms</span></div>';
        html += '<div class="pm-row"><span class="pm-label">Candidate Search</span><span class="pm-val">' + fmt(m.candidateSearchMs) + ' ms</span></div>';
        html += '<div class="pm-row"><span class="pm-label">Matching</span><span class="pm-val">' + fmt(m.matchingMs) + ' ms</span></div>';
        html += '<div class="pm-row"><span class="pm-label">API Request</span><span class="pm-val">' + fmt(m.apiMs) + ' ms</span></div>';
        html += '<div class="pm-row"><span class="pm-label">Evidence</span><span class="pm-val">' + fmt(m.evidenceMs) + ' ms</span></div>';
        html += '<div class="pm-row pm-total"><span class="pm-label">Total</span><span class="pm-val">' + fmt(m.totalMs) + ' ms</span></div>';
        html += '<div class="pm-divider"></div>';
        html += '<div class="pm-row"><span class="pm-label">FPS</span><span class="pm-val">' + (m.fps || 0) + '</span></div>';
        html += '<div class="pm-row"><span class="pm-label">Faces / frame</span><span class="pm-val">' + (m.faceCount || 0) + '</span></div>';
        html += '<div class="pm-row"><span class="pm-label">Candidates</span><span class="pm-val">' + (m.candidates || 0) + '</span></div>';
        html += '<div class="pm-row"><span class="pm-label">Comparisons</span><span class="pm-val">' + (m.comparisons || 0) + '</span></div>';
        html += '<div class="pm-row"><span class="pm-label">Avg Total (60f)</span><span class="pm-val">' + this.avg('totalMs').toFixed(1) + ' ms</span></div>';
        html += '</div>';
        el.innerHTML = html;
    };

    PM.updatePanelVisibility = function () {
        if (typeof document === 'undefined') return;
        var el = document.getElementById('perfDebugPanel');
        if (el) el.style.display = PM.enabled ? 'block' : 'none';
    };

    // Console log helper for ad-hoc measurements (model load, camera init, etc.)
    PM.log = function (label, value) {
        if (typeof console !== 'undefined' && console.log) {
            console.log('[PM] ' + label + ': ' + value + ' ms');
        }
    };

    // Export
    root.PM = PM;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = PM;
    }
})();
