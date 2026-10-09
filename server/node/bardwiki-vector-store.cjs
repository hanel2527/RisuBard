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
// Each KV deletion rewrites the whole manifest, so it covers many write batches.
const DELETE_BATCH = 4096;

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

    // Bumped by clear() so an in-flight migration stops instead of refilling the folder.
    let generation = 0;
    const exists = (file) => fsp.access(file).then(() => true, () => false);
    const yieldToRequests = () => new Promise((resolve) => setImmediate(resolve));

    // Moves KV vectors into the folder, then drops their KV entries and
    // unreferenced objects with one manifest save per DELETE_BATCH keys.
    async function migrateFromKv() {
        const started = generation;
        let moved = 0;
        for (;;) {
            const pending = options.kvList(VECTOR_PREFIX).filter(isBardWikiVectorKey);
            if (pending.length === 0) return moved;
            for (let offset = 0; offset < pending.length; offset += DELETE_BATCH) {
                const keys = pending.slice(offset, offset + DELETE_BATCH);
                // Folder writes run outside the storage queue; only the manifest
                // update holds it, so chat saves are not kept waiting.
                for (let index = 0; index < keys.length; index += MIGRATION_BATCH) {
                    if (generation !== started) return moved;
                    const batch = keys.slice(index, index + MIGRATION_BATCH);
                    // A folder copy already exists after an interrupted run or a newer client write.
                    const present = await Promise.all(batch.map((key) => exists(fileFor(key))));
                    const compacted = batch.filter((_, position) => !present[position])
                        .map((key) => ({ key, value: compactVector(options.kvGet(key)) }))
                        .filter((entry) => entry.value);
                    await writeMany(compacted);
                    moved += compacted.length;
                    await yieldToRequests();
                }
                if (generation !== started) return moved;
                await options.queueStorageOperation(async () => {
                    options.kvDelManyAndCollect(keys);
                });
                await yieldToRequests();
            }
        }
    }

    // Counts the folder plus vectors still waiting in the KV.
    async function usage() {
        const names = new Set();
        let bytes = 0;
        const shards = await fsp.readdir(root, { withFileTypes: true }).catch((error) => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        for (const shard of shards) {
            if (!shard.isDirectory()) continue;
            const files = (await fsp.readdir(path.join(root, shard.name))).filter((name) => name.endsWith('.rbv'));
            const sizes = await Promise.all(files.map((name) => fsp.stat(path.join(root, shard.name, name))
                .then((stat) => stat.size, () => null)));
            files.forEach((name, index) => {
                if (sizes[index] === null) return;
                names.add(name);
                bytes += sizes[index];
            });
        }
        let count = names.size;
        for (const key of options.kvList(VECTOR_PREFIX)) {
            if (!isBardWikiVectorKey(key) || names.has(path.basename(fileFor(key)))) continue;
            count += 1;
            bytes += options.kvSize(key);
        }
        return { count, bytes };
    }

    async function removeDeletedFolders() {
        const parent = path.dirname(root);
        const prefix = `${path.basename(root)}.deleting-`;
        const names = await fsp.readdir(parent).catch(() => []);
        await Promise.all(names.filter((name) => name.startsWith(prefix))
            .map((name) => fsp.rm(path.join(parent, name), { recursive: true, force: true })));
    }

    // Drops every cached vector; each one is embedded again when next needed.
    async function clear() {
        generation += 1;
        const before = await usage();
        // Renaming first lets new writes start a fresh folder while the old one is removed.
        try {
            await fsp.rename(root, `${root}.deleting-${crypto.randomUUID()}`);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const keys = options.kvList(VECTOR_PREFIX).filter(isBardWikiVectorKey);
        for (let offset = 0; offset < keys.length; offset += DELETE_BATCH) {
            const batch = keys.slice(offset, offset + DELETE_BATCH);
            await options.queueStorageOperation(async () => {
                options.kvDelManyAndCollect(batch);
            });
        }
        await removeDeletedFolders();
        return before;
    }

    return { read, write, writeMany, migrateFromKv, usage, clear, root };
}

module.exports = { createBardWikiVectorStore, isBardWikiVectorKey, compactVector };
