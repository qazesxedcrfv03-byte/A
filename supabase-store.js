'use strict';
/*
 * supabase-store.js — Unified persistence layer supporting both Supabase
 * (production) and local JSON files (test mode when ATTENDANCE_DATA_DIR is set).
 */
const fs = require('fs');
const path = require('path');
const supabase = require('./supabase-client');

const DATA_DIR = process.env.ATTENDANCE_DATA_DIR || '';

// Write lock: serialize all Supabase writes so concurrent requests cannot
// interleave a delete + insert (which previously caused duplicate-key errors)
// or interleave upserts. Local-JSON writes are synchronous and need no lock.
let _writeLocked = false;
const _writeQueue = [];
function _runNextWrite() {
    if (_writeLocked || _writeQueue.length === 0) return;
    _writeLocked = true;
    const task = _writeQueue.shift();
    task.fn().then(task.resolve, task.reject).finally(() => { _writeLocked = false; _runNextWrite(); });
}
function withWriteLock(fn) {
    return new Promise((resolve, reject) => {
        _writeQueue.push({ fn: fn, resolve: resolve, reject: reject });
        _runNextWrite();
    });
}

// Ensure the JSON file-data directory exists so saveTable never throws ENOENT
// (STEP 0 fix: the data dir may not be pre-created, causing a 500 on every save).
if (DATA_DIR) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore — exists or permission issue */ }
}

function filePath(table) {
    return path.join(DATA_DIR, table + '.json');
}

function loadJson(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function saveJson(file, arr) {
    const dir = path.dirname(file);
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e) { /* directory may already exist — safe to ignore */ }
    fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');
}

async function loadTable(table) {
    if (DATA_DIR) {
        return loadJson(filePath(table));
    }
    const { data, error } = await supabase.from(table).select('*');
    if (error) {
        console.error('[supabase] load error:', table, error.message);
        return [];
    }
    return Array.isArray(data) ? data : [];
}

async function saveTable(table, arr, idField = 'id') {
    const list = Array.isArray(arr) ? arr : [];
    if (DATA_DIR) {
        saveJson(filePath(table), list);
        return;
    }
    // Full-replace semantics (mirrors the old atomic whole-file rewrite), but
    // serialized via the write lock so concurrent saves cannot interleave a
    // delete + insert and trigger duplicate-key / constraint violations.
    await withWriteLock(async () => {
        const { error: delErr } = await supabase.from(table).delete().not(idField, 'is', null);
        if (delErr) {
            console.error('[supabase] delete error:', table, delErr.message);
            return;
        }
        if (list.length) {
            const { error: insErr } = await supabase.from(table).insert(list);
            if (insErr) {
                console.error('[supabase] insert error:', table, insErr.message);
            }
        }
    });
}

// Append-only / upsert persistence: inserts new rows or updates existing ones by
// id, WITHOUT a preceding delete-all. Used for append-only logs (audit) where a
// full-table rewrite would risk losing the trail if the process crashed between
// the delete and the insert. Idempotent against duplicate ids.
async function upsertRows(table, rows, idField = 'id') {
    const list = Array.isArray(rows) ? rows : [rows];
    if (!list.length) return;
    if (DATA_DIR) {
        const existing = loadJson(filePath(table));
        const byId = new Map();
        for (const r of existing) byId.set(r[idField], r);
        for (const r of list) byId.set(r[idField], r);
        saveJson(filePath(table), Array.from(byId.values()));
        return;
    }
    await withWriteLock(async () => {
        const { error } = await supabase.from(table).upsert(list, { onConflict: idField });
        if (error) console.error('[supabase] upsert error:', table, error.message);
    });
}

module.exports = { loadTable, saveTable, upsertRows };