'use strict';
/*
 * supabase-store.js — Unified persistence layer supporting both Supabase
 * (production) and local JSON files (test mode when ATTENDANCE_DATA_DIR is set).
 */
const fs = require('fs');
const path = require('path');
const supabase = require('./supabase-client');

const DATA_DIR = process.env.ATTENDANCE_DATA_DIR || '';

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
    // Full-replace semantics (mirrors the old atomic whole-file rewrite).
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
}

module.exports = { loadTable, saveTable };