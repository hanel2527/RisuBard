'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { atomicWriteJson, readVerifiedJson, recoverTransactions } = require('./file-store.cjs');

const MANIFEST_PATH = 'kv/manifest.json';
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

    let manifest = fs.existsSync(path.join(dataRoot, MANIFEST_PATH))
        ? readVerifiedJson(dataRoot, MANIFEST_PATH)
        : { schemaVersion: 1, updatedAt: 0, entries: {} };
    if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.entries !== 'object') {
        throw new Error('Unsupported or corrupt file KV manifest');
    }
    const objectWriteConcurrency = options.objectWriteConcurrency
        ?? Math.min(8, Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1));

    function saveManifest() {
        manifest.updatedAt = Date.now();
        atomicWriteJson(dataRoot, MANIFEST_PATH, manifest, {
            validate: value => value?.schemaVersion === 1 && typeof value?.entries === 'object',
        });
    }

    function kvGet(key) {
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
        manifest.entries[key] = { object: hash, size: data.length, updatedAt: Date.now() };
        saveManifest();
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
        for (const [key, entry] of prepareEntries(entries)) manifest.entries[key] = entry;
        if (entries.length) saveManifest();
    }

    async function kvSetManyAsync(entries) {
        const prepared = await prepareEntriesAsync(entries);
        for (const [key, entry] of prepared) manifest.entries[key] = entry;
        if (entries.length) saveManifest();
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

    async function kvReplaceAllAsync(entries) {
        const prepared = await prepareEntriesAsync(entries);
        manifest.entries = Object.fromEntries(prepared);
        saveManifest();
    }

    function kvDel(key) {
        if (!(key in manifest.entries)) return;
        delete manifest.entries[key];
        saveManifest();
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
        manifest.entries[destination] = { ...entry, updatedAt: Date.now() };
        saveManifest();
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
        kvReplaceAll,
        kvReplaceAllAsync,
        kvDel,
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
    };
}

module.exports = { createFileKv };
