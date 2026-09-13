'use strict';
const fs = require('fs');
const path = require('path');

function loadEnv(filePath) {
    const result = {};
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.length === 0 || line.startsWith('#')) continue;
            const idx = line.indexOf('=');
            if (idx === -1) continue;
            const key = line.substring(0, idx).trim();
            let value = line.substring(idx + 1).trim();
            if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
                value = value.substring(1, value.length - 1);
            } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
                value = value.substring(1, value.length - 1);
            }
            result[key] = value;
        }
    } catch (e) {}
    return result;
}

const env = loadEnv(path.join(__dirname, '.env'));

const SUPABASE_URL = env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';

let supabase = null;

function createOfflineStub() {
    const store = {};
    return {
        from(table) {
            if (!store[table]) store[table] = [];
            return {
                select() { return { data: store[table], error: null }; },
                insert(rows) {
                    if (Array.isArray(rows)) { store[table].push(...rows); } else { store[table].push(rows); }
                    return { data: rows, error: null };
                },
                delete() { return { not() { return { data: null, error: null }; } }; },
                upsert(rows) {
                    if (Array.isArray(rows)) { store[table].push(...rows); } else { store[table].push(rows); }
                    return { data: rows, error: null };
                },
                eq() { return { single() { return { data: null, error: null }; }, select() { return { data: store[table], error: null }; } }; }
            };
        },
        rpc() { return Promise.resolve({ data: [], error: null }); }
    };
}

function initSupabase() {
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
        try {
            let cleanUrl = SUPABASE_URL;
            const restIdx = cleanUrl.indexOf('/rest/v1');
            if (restIdx !== -1) { cleanUrl = cleanUrl.substring(0, restIdx); }
            const { createClient } = require('@supabase/supabase-js');
            const client = createClient(cleanUrl, SUPABASE_SERVICE_ROLE_KEY);
            console.log('[supabase] Client initialized for project:', cleanUrl);
            return client;
        } catch (e) {
            console.warn('[supabase] Failed to initialize Supabase client:', e.message);
            console.warn('[supabase] Falling back to offline stub storage.');
            return createOfflineStub();
        }
    } else {
        console.warn('[supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set.');
        console.warn('[supabase] Using offline stub storage (in-memory only).');
        return createOfflineStub();
    }
}

supabase = initSupabase();

module.exports = supabase;