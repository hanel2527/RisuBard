'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFile, atomicWriteJson, readVerifiedJson, resolveInside, commitTransaction, recoverTransactions } = require('./file-store.cjs');
const { sanitizeSegment, allocateSegment, collisionKey } = require('./friendly-paths.cjs');
const { createCharacterDirectoryResolver } = require('./character-directories.cjs');
const INDEX = 'index/character-asset-replicas.json';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validFilename = value => typeof value === 'string' && value.length > 0 && sanitizeSegment(value) === value;

function candidateNames(character) {
    const names = new Map();
    function add(key, label, extensionHint) {
        if (typeof key !== 'string' || !/^assets\/[A-Za-z0-9._-]+$/.test(key)) return;
        const basename = key.slice('assets/'.length);
        const extension = path.posix.extname(basename) || (/^[A-Za-z0-9]{1,16}$/.test(extensionHint || '') ? `.${extensionHint}` : '');
        let name = typeof label === 'string' && label.trim() ? label : basename;
        if (extension && !name.toLowerCase().endsWith(extension.toLowerCase())) name += extension;
        if (!names.has(key)) names.set(key, name);
    }
    // Preserve explicit asset labels where present; a hashed KV key cannot recover a lost upload filename.
    for (const asset of character.additionalAssets || []) add(asset?.[1], asset?.[0], asset?.[2]);
    for (const image of character.emotionImages || []) add(image?.[1], image?.[0]);
    add(character.image);
    return names;
}

function createCharacterAssets({ dataRoot, sourceSize, readOriginal, sourceVersion }) {
    let state = { schemaVersion: 1, characters: {} };
    let routes = new Map();
    const directories = createCharacterDirectoryResolver(dataRoot);
    let routeMapping;
    const synced = new Map();
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
        routeMapping = directories.snapshot();
        for (const [id, record] of Object.entries(state.characters)) {
            if (!validId(id) || record?.enabled !== true || !Array.isArray(record.entries)) continue;
            for (const entry of record.entries) {
                // Live-edit copies may change before reconciliation. Shared KV references
                // must keep serving immutable originals until new per-character keys publish.
                if (entry?.readFromKv === true) continue;
                if (entry && (entry.filename === undefined || validFilename(entry.filename)) && typeof entry.key === 'string' && entry.key.startsWith('assets/') && /^[a-f0-9]{64}$/.test(entry.hash) && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 64 * 1024 * 1024) {
                    try {
                        const target = safePath(`${directories.characterDirectory(id)}/assets/${entry.filename ?? entry.hash}`);
                        routes.set(entry.key, { ...entry, id, target });
                    } catch { /* Validate path boundaries at publication/load, outside normal reads. */ }
                }
            }
        }
    }
    function reload() {
        synced.clear();
        state = { schemaVersion: 1, characters: {} };
        try {
            safePath(INDEX);
            const loaded = readVerifiedJson(dataRoot, INDEX);
            if (loaded?.schemaVersion === 1 && loaded.characters && typeof loaded.characters === 'object' && !Array.isArray(loaded.characters)) state = loaded;
        } catch { /* An optional replica index must never prevent startup. */ }
        rebuild();
    }
    reload();
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
        if (!fs.existsSync(safePath(`${directories.characterDirectory(id)}/metadata.json`))) throw new Error('Canonical character is unavailable');
        const character = matches[0];
        const candidates = candidateNames(character);
        const directory = safePath(`${directories.characterDirectory(id)}/assets`);
        const occupied = new Set(fs.existsSync(directory) ? fs.readdirSync(directory) : []);
        const previous = state.characters[id]?.entries || [];
        // Conservative snapshot: any occurrence outside this character makes the asset shared.
        const otherData = JSON.stringify({ ...database, characters: database.characters.filter(value => value !== character) }).replace(/\\\\/g, '/');
        const record = { enabled: true, copied: 0, skipped: 0, failed: 0, entries: [] };
        for (const [key, sourceName] of candidates) {
            if (otherData.includes(key)) { record.skipped++; continue; }
            try {
                if (sourceSize(key) > 64 * 1024 * 1024) throw new Error('Oversized source');
                const bytes = (readOriginal || readSource)(key);
                if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024 * 1024) throw new Error('Missing or oversized source');
                const digest = hash(bytes);
                const preferred = allocateSegment(sourceName, new Set(), true);
                const old = previous.find(entry => entry?.key === key && entry.hash === digest && entry.sourceName === preferred && validFilename(entry.filename));
                let filename;
                if (old) {
                    try {
                        const oldPath = safePath(`${directories.characterDirectory(id)}/assets/${old.filename}`);
                        if (fs.statSync(oldPath).size === bytes.length && hash(fs.readFileSync(oldPath)) === digest) filename = old.filename;
                    } catch { /* Keep a damaged old copy untouched; publish a new verified filename. */ }
                }
                const needsWrite = !filename;
                if (!filename) {
                    filename = allocateSegment(preferred, occupied, true);
                    while ([...occupied].some(name => [filename, `${filename}.sha256`, `${filename}.bak`].some(candidate => collisionKey(candidate) === collisionKey(name)))) {
                        occupied.add(filename);
                        filename = allocateSegment(preferred, occupied, true);
                    }
                }
                const relative = `${directories.characterDirectory(id)}/assets/${filename}`;
                const target = safePath(relative);
                if (needsWrite) atomicWriteFile(dataRoot, relative, bytes);
                const verified = fs.readFileSync(target);
                if (verified.length !== bytes.length || hash(verified) !== digest) throw new Error('Replica verification failed');
                for (const name of [filename, `${filename}.sha256`, `${filename}.bak`]) occupied.add(name);
                record.entries.push({ key, filename, sourceName: preferred, hash: digest, size: bytes.length });
                record.copied++;
            } catch { record.failed++; }
        }
        // Only verified copies become readable. Interrupted copies are harmless and retryable.
        publish({ schemaVersion: 1, characters: { ...state.characters, [id]: record } });
        counters.copied += record.copied;
        counters.failed += record.failed;
        return status(id);
    }
    // Called inside the canonical writer queue, after external edits have been adopted.
    // Copies and both ownership indices publish together; retired bytes remain recoverable.
    function sync(database) {
        const mapping = directories.snapshot();
        const mapped = new Set(mapping.characters.filter(entry => entry.packageVersion === 1).map(entry => entry.id));
        const changed = (database.characters || []).filter(character => {
            if (!mapped.has(character.chaId) || character.type === 'group') return false;
            const signature = JSON.stringify([...candidateNames(character)].map(([key, name]) => [key, name, sourceVersion?.(key)]));
            return synced.get(character.chaId) !== signature;
        });
        if (!changed.length) return { changed: false };
        const livePath = 'index/live-character-assets.json';
        let live = { schemaVersion: 1, characters: {} };
        if (fs.existsSync(safePath(livePath))) live = readVerifiedJson(dataRoot, livePath);
        if (live?.schemaVersion !== 1 || !live.characters || Array.isArray(live.characters)) throw new Error('Invalid live asset index');
        const next = JSON.parse(JSON.stringify(state));
        const operations = [];
        const completed = new Map();
        const retirement = `trash/asset-sync-${crypto.randomUUID()}`;
        for (const character of changed) {
            const id = character.chaId;
            const relative = `${directories.characterDirectory(id)}/assets`;
            const directory = safePath(relative);
            const occupied = new Set(fs.existsSync(directory) ? fs.readdirSync(directory) : []);
            const candidates = candidateNames(character);
            const tracked = { ...(live.characters[id] || {}) };
            for (const entry of state.characters[id]?.entries || []) {
                const filename = entry.filename || entry.hash;
                tracked[filename] = { key: entry.key, hash: entry.hash };
            }
            const record = { enabled: true, copied: 0, skipped: 0, failed: 0, entries: [] };
            const kept = new Set();
            for (const [key, sourceName] of candidates) {
                const existing = Object.entries(tracked).find(([, entry]) => entry.key === key);
                // A copy belongs to this folder; even shared KV originals remain untouched.
                if (sourceSize(key) > 64 * 1024 * 1024) throw new Error('Oversized source');
                const bytes = readOriginal(key);
                if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('Missing or oversized source');
                const digest = hash(bytes);
                let filename = existing?.[1].hash === digest ? existing[0] : undefined;
                if (filename) {
                    const target = safePath(`${relative}/${filename}`);
                    if (!fs.existsSync(target) || hash(fs.readFileSync(target)) !== digest) {
                        const error = new Error(`Asset changed outside the app: ${filename}`);
                        error.code = 'CANONICAL_FILES_CHANGED';
                        throw error;
                    }
                } else {
                    filename = allocateSegment(sourceName, occupied, true);
                    while ([...occupied].some(name => [filename, `${filename}.sha256`, `${filename}.bak`].some(candidate => collisionKey(candidate) === collisionKey(name)))) {
                        occupied.add(filename);
                        filename = allocateSegment(sourceName, occupied, true);
                    }
                    safePath(`${relative}/${filename}`);
                    operations.push({ path: `${relative}/${filename}`, data: bytes });
                    for (const name of [filename, `${filename}.sha256`, `${filename}.bak`]) occupied.add(name);
                }
                kept.add(filename);
                tracked[filename] = { key, hash: digest };
                record.entries.push({ key, filename, sourceName: allocateSegment(sourceName, new Set(), true), hash: digest, size: bytes.length, readFromKv: true });
                record.copied++;
            }
            for (const [filename, entry] of Object.entries(tracked)) {
                if (!entry.key || kept.has(filename)) continue;
                const source = `${relative}/${filename}`;
                const target = safePath(source);
                if (fs.existsSync(target)) {
                    const bytes = fs.readFileSync(target);
                    if (hash(bytes) !== entry.hash) {
                        const error = new Error(`Asset changed outside the app: ${filename}`);
                        error.code = 'CANONICAL_FILES_CHANGED';
                        throw error;
                    }
                    // The unchanged write adds a hash precondition before the journal is prepared.
                    operations.push({ path: source, data: bytes });
                    operations.push({ path: source, moveTo: `${retirement}/${id}/${filename}` });
                    for (const suffix of ['.sha256', '.bak']) {
                        if (fs.existsSync(safePath(`${source}${suffix}`))) operations.push({ path: `${source}${suffix}`, moveTo: `${retirement}/${id}/${filename}${suffix}` });
                    }
                }
                delete tracked[filename];
            }
            next.characters[id] = record;
            live.characters[id] = tracked;
            completed.set(id, JSON.stringify([...candidates].map(([key, name]) => [key, name, sourceVersion?.(key)])));
        }
        operations.push({ path: INDEX, data: Buffer.from(JSON.stringify(next)) });
        operations.push({ path: livePath, data: Buffer.from(JSON.stringify(live)) });
        try { commitTransaction(dataRoot, operations); }
        catch (error) {
            recoverTransactions(dataRoot);
            reload();
            throw error;
        }
        state = next;
        rebuild();
        for (const [id, signature] of completed) synced.set(id, signature);
        return { changed: true };
    }
    function read(key, currentEntry) {
        try {
            if (directories.snapshot() !== routeMapping) rebuild();
        } catch { counters.fallbacks++; return null; }
        const entry = routes.get(key);
        if (!entry) return null;
        try {
            // KV remains authoritative: replacement, import and deletion invalidate old replicas.
            if (entry.hash !== currentEntry.object || entry.size !== currentEntry.size) throw new Error('Stale replica');
            // SHA-256 verification belongs to migration/revalidation, not every image read.
            const value = fs.readFileSync(entry.target);
            if (value.length !== entry.size) throw new Error('Invalid replica size');
            counters.reads++;
            return value;
        } catch { counters.fallbacks++; return null; }
    }
    function disable(id) {
        status(id);
        if (Object.hasOwn(state.characters, id)) publish({ schemaVersion: 1, characters: { ...state.characters, [id]: { ...state.characters[id], enabled: false } } });
        return status(id);
    }
    return { migrate, sync, read, status, disable, reload, diagnostics: () => ({ scope: 'server-session', ...counters }) };
}

module.exports = { createCharacterAssets };
