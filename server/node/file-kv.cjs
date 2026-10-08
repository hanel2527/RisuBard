'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { atomicWriteFile, atomicWriteJson, readVerifiedJson, recoverTransactions, resolveInside } = require('./file-store.cjs');
const { createCharacterAssets } = require('./character-assets.cjs');

const MANIFEST_PATH = 'kv/manifest.json';
const JOURNAL_PATH = 'kv/manifest.journal';
const JOURNAL_TYPE = 'risubard-kv-journal-v1';
const HEX_MIGRATION_MARKER = 'migration/legacy-hex-save-folder.json';

function digest(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function digestAsync(data) {
    return Buffer.from(await crypto.webcrypto.subtle.digest('SHA-256', data)).toString('hex');
}

async function inspectFileAsync(filePath) {
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(filePath)) {
        hash.update(chunk);
        size += chunk.length;
    }
    return { hash: hash.digest('hex'), size };
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

function writeObject(dataRoot, hash, data) {
    const directory = path.join(dataRoot, 'kv', 'objects');
    const target = path.join(directory, hash);
    if (fs.existsSync(target)) return;
    fs.mkdirSync(directory, { recursive: true });
    const temp = path.join(directory, `.${hash}.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    if (digest(fs.readFileSync(temp)) !== hash) {
        fs.unlinkSync(temp);
        throw new Error(`Content object checksum verification failed: ${hash}`);
    }
    try {
        fs.renameSync(temp, target);
    } catch (error) {
        if (fs.existsSync(target)) fs.unlinkSync(temp);
        else throw error;
    }
}

async function writeObjectAsync(dataRoot, hash, data) {
    const directory = path.join(dataRoot, 'kv', 'objects');
    const target = path.join(directory, hash);
    try {
        await fsp.access(target);
        return;
    } catch {}
    await fsp.mkdir(directory, { recursive: true });
    const temp = path.join(directory, `.${hash}.${crypto.randomUUID()}.tmp`);
    const handle = await fsp.open(temp, 'wx', 0o600);
    try {
        await handle.writeFile(data);
        await handle.sync();
    } finally {
        await handle.close();
    }
    if (await digestAsync(await fsp.readFile(temp)) !== hash) {
        await fsp.unlink(temp);
        throw new Error(`Content object checksum verification failed: ${hash}`);
    }
    try {
        await fsp.rename(temp, target);
    } catch (error) {
        try {
            await fsp.access(target);
            await fsp.unlink(temp);
        } catch {
            throw error;
        }
    }
}

async function writeObjectFromFileAsync(dataRoot, sourcePath) {
    const directory = path.join(dataRoot, 'kv', 'objects');
    await fsp.mkdir(directory, { recursive: true });
    const handle = await fsp.open(sourcePath, 'r+');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }

    const inspected = await inspectFileAsync(sourcePath);
    const target = path.join(directory, inspected.hash);
    try {
        await fsp.access(target);
        await fsp.unlink(sourcePath);
        return inspected;
    } catch {}

    try {
        await fsp.rename(sourcePath, target);
    } catch (error) {
        try {
            await fsp.access(target);
            await fsp.unlink(sourcePath);
        } catch {
            throw error;
        }
    }
    return inspected;
}

function createFileKv(options = {}) {
    const dataRoot = path.resolve(options.dataRoot || path.join(process.cwd(), 'save'));
    fs.mkdirSync(dataRoot, { recursive: true });
    recoverTransactions(dataRoot);
    const characterAssets = createCharacterAssets({ dataRoot, sourceSize: kvSize, readOriginal: kvGetOriginal,
        sourceVersion: key => manifest.entries[key]?.object,
        sourcePath: (key, expectedDigest) => {
            if (!/^[a-f0-9]{64}$/.test(expectedDigest) || manifest.entries[key]?.object !== expectedDigest) {
                throw new Error(`Content object changed during asset sync for ${key}`);
            }
            return resolveInside(dataRoot, path.join('kv', 'objects', expectedDigest));
        } });

    // manifest.json is the compacted snapshot. Ordinary writes append one line
    // to kv/manifest.journal instead of rewriting the snapshot, whose size
    // grows with every stored key (asset-heavy stores reach tens of MB).
    // The journal header names the snapshot it extends; a replaced snapshot
    // (backup restore, interrupted compaction) makes the journal stale.
    let manifest;
    let manifestBase = null;
    let manifestBytes = 0;
    // True while kv/manifest.journal extends the current snapshot. The file is
    // opened per append so Windows can still replace it during compaction.
    let journalReady = false;
    let journalBytes = 0;
    let journalChanged = false;
    const journalLimit = Number.isFinite(options.journalCompactBytes)
        ? Math.max(1, options.journalCompactBytes)
        : null;
    const journalTarget = () => resolveInside(dataRoot, JOURNAL_PATH);

    function closeJournal() {
        journalReady = false;
    }

    function startJournal(base) {
        closeJournal();
        const target = journalTarget();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const header = Buffer.from(`${JSON.stringify({ type: JOURNAL_TYPE, base })}\n`, 'utf8');
        const temp = `${target}.${crypto.randomUUID()}.tmp`;
        const fd = fs.openSync(temp, 'wx', 0o600);
        try {
            fs.writeSync(fd, header);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temp, target);
        journalReady = true;
        journalBytes = header.length;
        journalChanged = false;
    }

    function loadManifest() {
        closeJournal();
        const snapshotPath = path.join(dataRoot, MANIFEST_PATH);
        if (fs.existsSync(snapshotPath)) {
            manifest = readVerifiedJson(dataRoot, MANIFEST_PATH);
            const bytes = fs.readFileSync(snapshotPath);
            manifestBase = digest(bytes);
            manifestBytes = bytes.length;
        } else {
            manifest = { schemaVersion: 1, updatedAt: 0, entries: {} };
            manifestBase = null;
            manifestBytes = 0;
        }
        if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.entries !== 'object') {
            throw new Error('Unsupported or corrupt file KV manifest');
        }
        let lines = [];
        try {
            lines = fs.readFileSync(journalTarget(), 'utf8').split('\n');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        let header = null;
        try { header = lines[0] ? JSON.parse(lines[0]) : null; } catch {}
        if (!header || header.type !== JOURNAL_TYPE || header.base !== manifestBase || manifestBase === null) {
            if (lines.length) fs.rmSync(journalTarget(), { force: true });
            return;
        }
        // A torn final line from a crash ends replay; earlier lines were fsynced.
        let applied = 0;
        for (const line of lines.slice(1)) {
            if (!line) continue;
            let change;
            try { change = JSON.parse(line); } catch { break; }
            if (!change || typeof change !== 'object') break;
            for (const [key, entry] of Object.entries(change.set ?? {})) manifest.entries[key] = entry;
            for (const key of change.del ?? []) delete manifest.entries[key];
            applied += 1;
        }
        if (applied === 0) {
            journalReady = true;
            journalBytes = fs.statSync(journalTarget()).size;
            journalChanged = false;
            return;
        }
        // Fold replayed changes back into the snapshot so the journal stays short.
        writeSnapshot();
    }

    loadManifest();
    const objectWriteConcurrency = options.objectWriteConcurrency
        ?? Math.min(8, Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1));

    function writeSnapshot() {
        manifest.updatedAt = Date.now();
        // This internally constructed manifest was validated on load. JSON.stringify
        // already guarantees JSON syntax; reparsing a large asset index here only
        // duplicates allocation. Keep the same bytes and atomic/checksum/fsync path.
        if (manifest.schemaVersion !== 1 || !manifest.entries || typeof manifest.entries !== 'object') {
            throw new Error('Unsupported or corrupt file KV manifest');
        }
        const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        atomicWriteFile(dataRoot, MANIFEST_PATH, bytes);
        manifestBase = digest(bytes);
        manifestBytes = bytes.length;
        startJournal(manifestBase);
    }

    // Whole-set operations rewrite the snapshot; key-level changes append.
    function saveManifest() {
        writeSnapshot();
    }

    function recordChanges(set, del = []) {
        if (!journalReady || manifestBase === null) {
            writeSnapshot();
            return;
        }
        const line = Buffer.from(`${JSON.stringify({ set, del })}\n`, 'utf8');
        const fd = fs.openSync(journalTarget(), 'a');
        try {
            fs.writeSync(fd, line);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        journalBytes += line.length;
        journalChanged = true;
        if (journalBytes > (journalLimit ?? Math.max(8 * 1024 * 1024, manifestBytes))) writeSnapshot();
    }

    function compactManifest() {
        if (journalReady && journalChanged) writeSnapshot();
    }

    function kvGet(key) {
        const entry = manifest.entries[key];
        if (!entry) return null;
        const replica = characterAssets.read(key, entry);
        if (replica !== null) return replica;
        return kvGetOriginal(key);
    }

    // Explicit asset validation must bypass the performance-oriented replica reader.
    function kvGetOriginal(key) {
        const entry = manifest.entries[key];
        if (!entry) return null;
        const objectPath = path.join(dataRoot, 'kv', 'objects', entry.object);
        let value;
        try { value = fs.readFileSync(objectPath); } catch { return null; }
        if (digest(value) !== entry.object) throw new Error(`Content object checksum mismatch for ${key}`);
        return value;
    }

    function kvSet(key, value) {
        const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const hash = digest(data);
        writeObject(dataRoot, hash, data);
        const entry = { object: hash, size: data.length, updatedAt: Date.now() };
        manifest.entries[key] = entry;
        recordChanges({ [key]: entry });
    }

    function prepareEntries(entries) {
        return entries.map(({ key, value }) => {
            const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
            const hash = digest(data);
            writeObject(dataRoot, hash, data);
            return [key, { object: hash, size: data.length, updatedAt: Date.now() }];
        });
    }

    async function prepareEntriesAsync(entries) {
        return mapWithConcurrency(entries, objectWriteConcurrency, async ({ key, value }) => {
            const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
            const hash = await digestAsync(data);
            await writeObjectAsync(dataRoot, hash, data);
            return [key, { object: hash, size: data.length, updatedAt: Date.now() }];
        });
    }

    async function prepareFileEntriesAsync(entries) {
        return mapWithConcurrency(entries, objectWriteConcurrency, async ({ key, sourcePath }) => {
            const prepared = await writeObjectFromFileAsync(dataRoot, sourcePath);
            return [key, { object: prepared.hash, size: prepared.size, updatedAt: Date.now() }];
        });
    }

    function kvSetMany(entries) {
        const prepared = prepareEntries(entries);
        for (const [key, entry] of prepared) manifest.entries[key] = entry;
        if (entries.length) recordChanges(Object.fromEntries(prepared));
    }

    async function kvSetManyAsync(entries) {
        const prepared = await prepareEntriesAsync(entries);
        for (const [key, entry] of prepared) manifest.entries[key] = entry;
        if (entries.length) recordChanges(Object.fromEntries(prepared));
    }

    function kvReplacePrefixes(entries, prefixes) {
        const next = { ...manifest.entries };
        for (const key of Object.keys(next)) {
            if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
        }
        for (const [key, entry] of prepareEntries(entries)) next[key] = entry;
        manifest.entries = next;
        saveManifest();
    }

    function kvReplaceAll(entries) {
        manifest.entries = Object.fromEntries(prepareEntries(entries));
        saveManifest();
    }

    async function kvReplacePrefixesAsync(entries, prefixes) {
        const prepared = await prepareEntriesAsync(entries);
        const next = { ...manifest.entries };
        for (const key of Object.keys(next)) {
            if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
        }
        for (const [key, entry] of prepared) next[key] = entry;
        manifest.entries = next;
        saveManifest();
    }

    async function kvReplacePrefixesFromFilesAsync(entries, prefixes) {
        const prepared = await prepareFileEntriesAsync(entries);
        const next = { ...manifest.entries };
        for (const key of Object.keys(next)) {
            if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
        }
        for (const [key, entry] of prepared) next[key] = entry;
        manifest.entries = next;
        saveManifest();
    }

    async function preparePrefixReplacementFromFilesAsync(entries, prefixes) {
        const prepared = await prepareFileEntriesAsync(entries);
        const next = { ...manifest.entries };
        for (const key of Object.keys(next)) {
            if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
        }
        for (const [key, entry] of prepared) next[key] = entry;
        const candidate = { schemaVersion: 1, updatedAt: Date.now(), entries: next };
        return { manifestBytes: Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8') };
    }

    function reloadManifest() {
        loadManifest();
        characterAssets.reload();
    }

    async function kvReplaceAllAsync(entries) {
        const prepared = await prepareEntriesAsync(entries);
        manifest.entries = Object.fromEntries(prepared);
        saveManifest();
    }

    function kvDel(key) {
        if (!(key in manifest.entries)) return;
        delete manifest.entries[key];
        recordChanges({}, [key]);
    }

    function kvDelMany(keys) {
        let count = 0;
        let bytes = 0;
        const deleted = [];
        for (const key of new Set(keys)) {
            const entry = manifest.entries[key];
            if (!entry) continue;
            bytes += entry.size ?? 0;
            delete manifest.entries[key];
            deleted.push(key);
            count += 1;
        }
        if (count > 0) recordChanges({}, deleted);
        return { count, bytes };
    }

    function kvDelManyAndCollect(keys) {
        const objects = new Set(keys.map(key => manifest.entries[key]?.object).filter(Boolean));
        const previous = { ...manifest.entries };
        let deleted;
        try { deleted = kvDelMany(keys); }
        catch (error) { manifest.entries = previous; throw error; }
        const referenced = referencedObjects();
        let reclaimed = 0;
        for (const object of objects) {
            if (!/^[a-f0-9]{64}$/.test(object) || referenced.has(object)) continue;
            const target = resolveInside(dataRoot, path.join('kv', 'objects', object));
            try {
                const size = fs.statSync(target).size;
                fs.unlinkSync(target);
                reclaimed += size;
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return { ...deleted, reclaimed };
    }

    function kvSize(key) {
        return manifest.entries[key]?.size ?? 0;
    }

    function kvGetUpdatedAt(key) {
        return manifest.entries[key]?.updatedAt ?? null;
    }

    function kvCopyValue(source, destination) {
        const entry = manifest.entries[source];
        if (!entry) return;
        const copied = { ...entry, updatedAt: Date.now() };
        manifest.entries[destination] = copied;
        recordChanges({ [destination]: copied });
    }

    function kvDelPrefix(prefix) {
        let changed = false;
        for (const key of Object.keys(manifest.entries)) {
            if (key.startsWith(prefix)) {
                delete manifest.entries[key];
                changed = true;
            }
        }
        if (changed) saveManifest();
    }

    function kvList(prefix = '') {
        return Object.keys(manifest.entries).filter(key => key.startsWith(prefix)).sort();
    }

    function kvListWithSizes(prefix = '') {
        return kvList(prefix).map(key => ({ key, size: manifest.entries[key].size }));
    }

    function referencedObjects() {
        return new Set(Object.values(manifest.entries).map(entry => entry.object));
    }

    function reclaimableObjects() {
        const directory = path.join(dataRoot, 'kv', 'objects');
        if (!fs.existsSync(directory)) return [];
        const referenced = referencedObjects();
        return fs.readdirSync(directory)
            .filter(name => /^[a-f0-9]{64}$/.test(name) && !referenced.has(name));
    }

    function reclaimableChunkBytes() {
        return reclaimableObjects().reduce((total, name) => {
            try { return total + fs.statSync(path.join(dataRoot, 'kv', 'objects', name)).size; }
            catch { return total; }
        }, 0);
    }

    function objectStoreBytes() {
        const directory = path.join(dataRoot, 'kv', 'objects');
        if (!fs.existsSync(directory)) return 0;
        return fs.readdirSync(directory).reduce((total, name) => {
            if (!/^[a-f0-9]{64}$/.test(name)) return total;
            try { return total + fs.statSync(path.join(directory, name)).size; }
            catch { return total; }
        }, 0);
    }

    function gcChunks(options = {}) {
        const minAgeMs = Number.isFinite(options.minAgeMs) ? Math.max(0, options.minAgeMs) : 0;
        const maxDeletes = Number.isFinite(options.maxDeletes)
            ? Math.max(0, Math.floor(options.maxDeletes))
            : Number.POSITIVE_INFINITY;
        const now = Number.isFinite(options.now) ? options.now : Date.now();
        const objects = reclaimableObjects();
        let count = 0;
        let bytes = 0;
        for (const name of objects) {
            if (count >= maxDeletes) break;
            const objectPath = path.join(dataRoot, 'kv', 'objects', name);
            try {
                const stat = fs.statSync(objectPath);
                if (minAgeMs > 0 && now - stat.mtimeMs < minAgeMs) continue;
                fs.unlinkSync(objectPath);
                count += 1;
                bytes += stat.size;
            } catch {}
        }
        return { count, bytes };
    }

    function snapshotFootprint(key) {
        const entry = manifest.entries[key];
        if (!entry) return 0;
        const live = manifest.entries['database/database.bin'];
        return live && live.object === entry.object ? 0 : entry.size;
    }

    function migrateLegacyHexFiles() {
        if (fs.existsSync(path.join(dataRoot, HEX_MIGRATION_MARKER))) return;
        const files = fs.readdirSync(dataRoot, { withFileTypes: true })
            .filter(entry => entry.isFile() && /^[a-fA-F0-9]+$/.test(entry.name) && entry.name.length % 2 === 0);
        let imported = 0;
        for (const entry of files) {
            const key = Buffer.from(entry.name, 'hex').toString('utf8');
            if (!key || key in manifest.entries) continue;
            const data = fs.readFileSync(path.join(dataRoot, entry.name));
            const hash = digest(data);
            writeObject(dataRoot, hash, data);
            manifest.entries[key] = { object: hash, size: data.length, updatedAt: fs.statSync(path.join(dataRoot, entry.name)).mtimeMs };
            imported += 1;
        }
        if (imported) saveManifest();
        atomicWriteJson(dataRoot, HEX_MIGRATION_MARKER, { schemaVersion: 1, imported, completedAt: Date.now() });
    }

    migrateLegacyHexFiles();

    return {
        kvGet,
        kvSet,
        kvSetMany,
        kvSetManyAsync,
        kvReplacePrefixes,
        kvReplacePrefixesAsync,
        kvReplacePrefixesFromFilesAsync,
        preparePrefixReplacementFromFilesAsync,
        reloadManifest,
        compactManifest,
        kvReplaceAll,
        kvReplaceAllAsync,
        kvDel,
        kvDelMany,
        kvDelManyAndCollect,
        kvSize,
        kvGetUpdatedAt,
        kvCopyValue,
        kvDelPrefix,
        kvList,
        kvListWithSizes,
        gcChunks,
        reclaimableChunkBytes,
        objectStoreBytes,
        snapshotFootprint,
        characterAssets,
    };
}

module.exports = { createFileKv };
