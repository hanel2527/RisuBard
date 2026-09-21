'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFile, atomicWriteJson, readVerifiedJson, resolveInside } = require('./file-store.cjs');
const INDEX = 'index/character-asset-replicas.json';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function createCharacterAssets({ dataRoot, sourceSize }) {
    let state = { schemaVersion: 1, characters: {} };
    let routes = new Map();
    const counters = { reads: 0, fallbacks: 0, copied: 0, failed: 0 };
    function safePath(relative) {
        const target = resolveInside(dataRoot, relative);
        let current = dataRoot;
        for (const part of path.relative(dataRoot, target).split(path.sep)) {
            current = path.join(current, part);
            if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Asset path uses a symbolic link');
        }
        return target;
    }
    function rebuild() {
        routes = new Map();
        for (const [id, record] of Object.entries(state.characters)) {
            if (!validId(id) || record?.enabled !== true || !Array.isArray(record.entries)) continue;
            for (const entry of record.entries) {
                if (entry && typeof entry.key === 'string' && entry.key.startsWith('assets/') && /^[a-f0-9]{64}$/.test(entry.hash) && Number.isSafeInteger(entry.size) && entry.size >= 0) {
                    routes.set(entry.key, { ...entry, id });
                }
            }
        }
    }
    try {
        safePath(INDEX);
        const loaded = readVerifiedJson(dataRoot, INDEX);
        if (loaded?.schemaVersion === 1 && loaded.characters && typeof loaded.characters === 'object' && !Array.isArray(loaded.characters)) state = loaded;
    } catch { /* An optional replica index must never prevent startup. */ }
    rebuild();
    function publish(next) {
        safePath(INDEX);
        atomicWriteJson(dataRoot, INDEX, next);
        state = next;
        rebuild();
    }
    function status(id) {
        if (!validId(id)) throw new Error('Invalid character ID');
        const record = Object.hasOwn(state.characters, id) ? state.characters[id] : null;
        return record ? { enabled: record.enabled, copied: record.copied, skipped: record.skipped, failed: record.failed } : { enabled: false, copied: 0, skipped: 0, failed: 0 };
    }
    function migrate(database, id, readSource) {
        if (!validId(id)) throw new Error('Invalid character ID');
        const matches = database.characters?.filter(character => character.chaId === id);
        if (matches?.length !== 1 || matches[0].type === 'group') throw new Error('A unique character is required');
        if (!fs.existsSync(safePath(`characters/${id}/metadata.json`))) throw new Error('Canonical character is unavailable');
        const character = matches[0];
        const candidates = new Set([character.image,
            ...(character.emotionImages || []).map(value => value?.[1]),
            ...(character.additionalAssets || []).map(value => value?.[1])]
            .filter(value => typeof value === 'string' && /^assets\/[A-Za-z0-9._-]+$/.test(value)));
        // Conservative snapshot: any occurrence outside this character makes the asset shared.
        const otherData = JSON.stringify({ ...database, characters: database.characters.filter(value => value !== character) }).replace(/\\\\/g, '/');
        const record = { enabled: true, copied: 0, skipped: 0, failed: 0, entries: [] };
        for (const key of candidates) {
            if (otherData.includes(key)) { record.skipped++; continue; }
            try {
                if (sourceSize(key) > 64 * 1024 * 1024) throw new Error('Oversized source');
                const bytes = readSource(key);
                if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024 * 1024) throw new Error('Missing or oversized source');
                const digest = hash(bytes);
                const relative = `characters/${id}/assets/${digest}`;
                const target = safePath(relative);
                atomicWriteFile(dataRoot, relative, bytes);
                const verified = fs.readFileSync(target);
                if (verified.length !== bytes.length || hash(verified) !== digest) throw new Error('Replica verification failed');
                record.entries.push({ key, hash: digest, size: bytes.length });
                record.copied++;
            } catch { record.failed++; }
        }
        // Only verified copies become readable. Interrupted copies are harmless and retryable.
        publish({ schemaVersion: 1, characters: { ...state.characters, [id]: record } });
        counters.copied += record.copied;
        counters.failed += record.failed;
        return status(id);
    }
    function read(key, currentEntry) {
        const entry = routes.get(key);
        if (!entry) return null;
        try {
            // KV remains authoritative: replacement, import and deletion invalidate old replicas.
            if (entry.hash !== currentEntry.object || entry.size !== currentEntry.size) throw new Error('Stale replica');
            if (!fs.existsSync(safePath(`characters/${entry.id}/metadata.json`))) throw new Error('Character removed');
            const target = safePath(`characters/${entry.id}/assets/${entry.hash}`);
            if (fs.statSync(target).size !== entry.size || entry.size > 64 * 1024 * 1024) throw new Error('Invalid replica size');
            const value = fs.readFileSync(target);
            if (value.length !== entry.size || hash(value) !== entry.hash) throw new Error('Invalid replica');
            counters.reads++;
            return value;
        } catch { counters.fallbacks++; return null; }
    }
    function disable(id) {
        status(id);
        if (Object.hasOwn(state.characters, id)) publish({ schemaVersion: 1, characters: { ...state.characters, [id]: { ...state.characters[id], enabled: false } } });
        return status(id);
    }
    return { migrate, read, status, disable, diagnostics: () => ({ scope: 'server-session', ...counters }) };
}

module.exports = { createCharacterAssets };
