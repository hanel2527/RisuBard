'use strict';

// BardWiki embedding vectors live in <dataRoot>/bardwiki-vectors/<aa>/<hash>.rbv
// instead of the file KV. They are a rebuildable cache with thousands of
// entries per long chat; in the KV every entry grew the manifest that each
// KV write rewrites, so unrelated writes (asset imports) slowed down with it.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const VECTOR_PREFIX = 'cache/bardwiki-vector/';
const VECTOR_NAME = /^[0-9a-f]{64}\.json$/;
const MAGIC = Buffer.from('RBV1', 'latin1');
const MIGRATION_BATCH = 256;

function isBardWikiVectorKey(key) {
    return typeof key === 'string' && key.startsWith(VECTOR_PREFIX)
        && VECTOR_NAME.test(key.slice(VECTOR_PREFIX.length));
}

// RBV1 + little-endian Float32; JSON arrays from older clients are converted.
function compactVector(value) {
    if (!value || value.length === 0) return null;
    if (value.length > MAGIC.length && value.subarray(0, MAGIC.length).equals(MAGIC)) return value;
    try {
        const parsed = JSON.parse(value.toString('utf8'));
        if (!Array.isArray(parsed) || parsed.length === 0
            || !parsed.every((item) => typeof item === 'number' && Number.isFinite(item))) return null;
        const out = Buffer.alloc(MAGIC.length + parsed.length * 4);
        MAGIC.copy(out);
        parsed.forEach((item, index) => out.writeFloatLE(item, MAGIC.length + index * 4));
        return out;
    } catch {
        return null;
    }
}

function createBardWikiVectorStore(options) {
    const root = path.join(options.dataRoot, 'bardwiki-vectors');
    const fileFor = (key) => {
        const name = key.slice(VECTOR_PREFIX.length).replace(/\.json$/, '.rbv');
        return path.join(root, name.slice(0, 2), name);
    };

    async function write(key, value) {
        const target = fileFor(key);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const temporary = `${target}.${crypto.randomUUID()}.tmp`;
        // Rebuildable cache: atomic rename without fsync; a torn file fails
        // the client's length check and is simply embedded again.
        await fsp.writeFile(temporary, value, { mode: 0o600 });
        try {
            await fsp.rename(temporary, target);
        } catch (error) {
            await fsp.rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    async function read(key) {
        try {
            return await fsp.readFile(fileFor(key));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        // Not migrated yet: serve the KV copy until the background move runs.
        const legacy = options.kvGet(key);
        return legacy && legacy.length > 0 ? Buffer.from(legacy) : null;
    }

    async function writeMany(entries) {
        for (let index = 0; index < entries.length; index += 16) {
            await Promise.all(entries.slice(index, index + 16)
                .map((entry) => write(entry.key, entry.value)));
        }
    }

    // Moves KV vectors into the folder in batches, then drops their KV
    // entries and unreferenced objects with one manifest save per batch.
    async function migrateFromKv() {
        let moved = 0;
        for (;;) {
            const keys = options.kvList(VECTOR_PREFIX).filter(isBardWikiVectorKey)
                .slice(0, MIGRATION_BATCH);
            if (keys.length === 0) return moved;
            // Folder writes run outside the storage queue; only the manifest
            // update holds it, so chat saves are not kept waiting.
            const compacted = keys
                .map((key) => ({ key, value: compactVector(options.kvGet(key)) }))
                .filter((entry) => entry.value);
            await writeMany(compacted);
            moved += compacted.length;
            await options.queueStorageOperation(async () => {
                options.kvDelManyAndCollect(keys);
            });
            await new Promise((resolve) => setImmediate(resolve));
        }
    }

    return { read, write, writeMany, migrateFromKv, root };
}

module.exports = { createBardWikiVectorStore, isBardWikiVectorKey, compactVector };
