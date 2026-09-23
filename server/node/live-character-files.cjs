'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveInside, readVerifiedJson, atomicWriteJson } = require('./file-store.cjs');
const { createCharacterDirectoryResolver } = require('./character-directories.cjs');
const INDEX = 'index/live-character-assets.json';
const IGNORED_FILES = /\.(?:sha256|bak|tmp|part|swp|crdownload)$/i;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function createLiveFileRecovery(root) {
    const active = 'trash/live-files-recovery/pending.json';
    return {
        load() {
            if (!fs.existsSync(resolveInside(root, active))) return null;
            const info = readVerifiedJson(root, active);
            return info ? { info, record: readVerifiedJson(root, info.path) } : null;
        },
        save(record) {
            const relative = `trash/live-files-recovery/${crypto.randomUUID()}.json`;
            atomicWriteJson(root, relative, { schemaVersion: 1, createdAt: new Date().toISOString(), ...record });
            const info = { path: relative, conflicts: record.conflicts.length };
            atomicWriteJson(root, active, info);
            return info;
        },
        complete() {
            if (fs.existsSync(resolveInside(root, active))) atomicWriteJson(root, active, null);
        },
    };
}

function metadataSnapshot(database) {
    return {
        characters: (database?.characters || []).map(({ chats, chatPage, ...metadata }) => structuredClone(metadata)),
        loreBook: structuredClone(database?.loreBook || []),
    };
}

function mergePendingLiveDatabase(pending, baseline, external, conflicts = []) {
    const merged = { ...pending };
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    merged.characters = pending.characters.map(local => {
        const before = baseline.characters.find(value => value.chaId === local.chaId);
        const after = external.characters.find(value => value.chaId === local.chaId);
        if (!before || !after) return local;
        const result = { ...local };
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (['chats', 'chatPage', 'chaId'].includes(key) || equal(before[key], after[key])) continue;
            if (!equal(local[key], before[key]) && !equal(local[key], after[key])) {
                conflicts.push({ characterId: local.chaId, field: key, local: local[key], external: after[key], baseline: before[key] });
            }
            if (Object.hasOwn(after, key)) result[key] = after[key];
            else delete result[key];
        }
        return result;
    });
    if (!equal(baseline.loreBook, external.loreBook)) {
        if (!equal(pending.loreBook, baseline.loreBook) && !equal(pending.loreBook, external.loreBook)) {
            conflicts.push({ field: 'loreBook', local: pending.loreBook, external: external.loreBook, baseline: baseline.loreBook });
        }
        merged.loreBook = external.loreBook;
    }
    return merged;
}

/** Files are inputs; never overwrite a partially saved editor buffer. */
function createLiveCharacterFiles({ repository, writeAsset, writeAssets, reloadAssets = () => {}, watch = true, settleMs = 250 }) {
    const root = repository.dataRoot;
    const directories = createCharacterDirectoryResolver(root);
    let accepted = repository.getProjectionRevision();
    let baseline;
    let needsInitialReconcile = false;
    try { baseline = metadataSnapshot(repository.exportLegacyDatabase({ metadataOnly: true })); }
    catch { baseline = { characters: [], loreBook: [] }; needsInitialReconcile = true; }
    let dirty = true;
    let assetsDirty = true;
    let changedAt = 0;
    let watcher;
    let fallback = false;
    let lastScan = 0;
    const fingerprints = new Map();
    function safe(relative) {
        const target = resolveInside(root, relative);
        let current = root;
        for (const part of path.relative(root, target).split(path.sep)) {
            current = path.join(current, part);
            if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`External edit uses a symbolic link: ${relative}`);
        }
        return target;
    }
    function readIndex(relative, initial) {
        safe(relative);
        return fs.existsSync(resolveInside(root, relative)) ? readVerifiedJson(root, relative, { allowBackup: false }) : initial;
    }
    function invalidate(includeAssets = true) { dirty = true; assetsDirty ||= includeAssets; changedAt = Date.now(); }
    if (watch) {
        try {
            watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
                const name = String(filename || '').replaceAll('\\', '/');
                if (!name || /^characters\/[^/]+(?:\/metadata\.json|\/assets(?:\/[^/]+)?)?$/.test(name)
                    || /^lorebooks(?:\/[^/]+\.json)?$/.test(name)
                    || /^index\/(?:character-directories|character-asset-replicas)\.json$/.test(name)) {
                    invalidate(!name || name.includes('/assets') || name.startsWith('index/') || /^characters\/[^/]+$/.test(name));
                }
            });
            watcher.on('error', () => { fallback = true; dirty = true; });
            watcher.unref();
        } catch { fallback = true; }
    }
    function planAssets() {
        directories.refresh();
        const previous = readIndex(INDEX, { schemaVersion: 1, characters: {} });
        if (previous.schemaVersion !== 1 || !previous.characters || Array.isArray(previous.characters)) throw new Error('Invalid live asset index');
        const replicas = readIndex('index/character-asset-replicas.json', { characters: {} });
        let replicasChanged = false;
        const next = structuredClone(previous);
        const metadata = new Map();
        const originals = new Map();
        const pending = [];
        for (const id of directories.characterIds()) {
            const relative = directories.characterDirectory(id).replaceAll('\\', '/');
            const assetRoot = safe(`${relative}/assets`);
            const old = { ...previous.characters[id], ...Object.fromEntries(
                (replicas.characters?.[id]?.enabled ? replicas.characters[id].entries || [] : [])
                    .map(entry => [entry.filename || entry.hash, { key: entry.key, hash: entry.hash }]),
            ) };
            const entries = fs.existsSync(assetRoot) ? fs.readdirSync(assetRoot, { withFileTypes: true }) : [];
            if (!entries.length && !Object.keys(old).length) continue;
            const filenameSet = new Set();
            const values = Object.create(null);
            const metadataPath = `${relative}/metadata.json`;
            const original = fs.readFileSync(safe(metadataPath));
            const character = JSON.parse(original.toString('utf8'));
            let changed = false;
            function retireReplica(filename) {
                const record = replicas.characters?.[id];
                if (!record?.entries) return;
                const entries = record.entries.filter(entry => (entry.filename || entry.hash) !== filename);
                if (entries.length !== record.entries.length) {
                    record.entries = entries;
                    record.copied = entries.length;
                    replicasChanged = true;
                }
            }
            function replaceReference(from, to) {
                if (character.image === from) { character.image = to || ''; changed = true; }
                for (const field of ['additionalAssets', 'emotionImages']) {
                    if (!Array.isArray(character[field])) continue;
                    character[field] = character[field].flatMap(entry => {
                        if (entry?.[1] !== from) return [entry];
                        changed = true;
                        return to ? [[entry[0], to, ...entry.slice(2)]] : [];
                    });
                }
            }
            for (const entry of entries) {
                if (entry.name.startsWith('.') || IGNORED_FILES.test(entry.name)) continue;
                if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Asset must be a regular file: ${entry.name}`);
                const target = safe(`${relative}/assets/${entry.name}`);
                const stat = fs.statSync(target, { bigint: true });
                if (stat.size > 64n * 1024n * 1024n) throw new Error(`Asset exceeds 64 MiB: ${entry.name}`);
                if (!stat.size) throw new Error(`Asset is still empty: ${entry.name}`);
                const stamp = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
                const cached = fingerprints.get(target);
                let bytes;
                const digest = cached?.stamp === stamp ? cached.hash : hash(bytes = fs.readFileSync(target));
                fingerprints.set(target, { stamp, hash: digest });
                filenameSet.add(entry.name);
                const prior = old[entry.name];
                if (prior?.hash === digest) { values[entry.name] = prior; continue; }
                // A1 leaves unregistered historical copies behind. Their valid
                // sidecars identify app-created files, not newly dropped input.
                // Remember them without importing; a later external edit has a
                // different hash and will enter the ordinary import path.
                if (!prior && fs.existsSync(`${target}.sha256`)
                    && fs.readFileSync(`${target}.sha256`, 'utf8').trim() === digest) {
                    values[entry.name] = { hash: digest, ignored: true };
                    continue;
                }
                retireReplica(entry.name);
                bytes ||= fs.readFileSync(target);
                const after = fs.statSync(target, { bigint: true });
                if (`${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== stamp || hash(bytes) !== digest) throw new Error(`Asset changed while reading: ${entry.name}`);
                const suffix = path.extname(entry.name).slice(1).toLowerCase();
                const extension = /^[a-z0-9]{1,16}$/.test(suffix) ? suffix : 'bin';
                const key = `assets/live-${hash(Buffer.from(`${id}\0${entry.name}`)).slice(0, 16)}-${digest}.${extension}`;
                pending.push({ key, bytes });
                values[entry.name] = { key, hash: digest };
                if (prior?.key) replaceReference(prior.key, key);
                else {
                    character.additionalAssets ||= [];
                    character.additionalAssets.push([path.basename(entry.name, path.extname(entry.name)), key, extension]);
                    changed = true;
                }
            }
            for (const [filename, entry] of Object.entries(old)) {
                if (!filenameSet.has(filename)) { if (entry.key) replaceReference(entry.key, null); retireReplica(filename); }
            }
            next.characters[id] = values;
            if (changed) { metadata.set(metadataPath, json(character)); originals.set(metadataPath, original); }
        }
        const operations = JSON.stringify(previous) === JSON.stringify(next) ? [] : [{ path: INDEX, data: json(next) }];
        if (replicasChanged) operations.push({ path: 'index/character-asset-replicas.json', data: json(replicas) });
        return { metadata, originals, pending, operations, replicasChanged };
    }
    function reconcile() {
        if (fallback && Date.now() - lastScan >= 1000) { dirty = true; assetsDirty = true; }
        if (!dirty) return null;
        if (Date.now() - changedAt < settleMs) {
            const error = new Error('External files are being saved; retry in a moment');
            error.code = 'LIVE_FILES_SETTLING';
            throw error;
        }
        lastScan = Date.now();
        const plan = assetsDirty ? planAssets() : { metadata: new Map(), pending: [], operations: [] };
        const revision = repository.getProjectionRevision();
        if (!needsInitialReconcile && revision === accepted && !plan.metadata.size && !plan.operations.length) { dirty = false; assetsDirty = false; return null; }
        // Immutable keys can be staged first: interruption leaves only an unused
        // KV object. Metadata and filename ownership are published in one journal.
        if (plan.pending.length && writeAssets) writeAssets(plan.pending.map(asset => ({ key: asset.key, value: asset.bytes })));
        else for (const asset of plan.pending) writeAsset(asset.key, asset.bytes);
        const result = repository.reconcileCanonicalProjection({
            externalEditing: true, externalMetadata: plan.metadata, externalOriginals: plan.originals, externalOperations: plan.operations,
        });
        if (plan.replicasChanged) reloadAssets();
        result.previous = baseline;
        accepted = result.revision;
        baseline = metadataSnapshot(result.database);
        needsInitialReconcile = false;
        dirty = false;
        assetsDirty = false;
        return result;
    }
    return {
        reconcile, invalidate,
        reset: () => {
            fingerprints.clear();
            directories.refresh();
            accepted = repository.getProjectionRevision();
            baseline = metadataSnapshot(repository.exportLegacyDatabase({ metadataOnly: true }));
            needsInitialReconcile = false;
            invalidate();
        },
        accept: database => {
            accepted = repository.getProjectionRevision();
            baseline = metadataSnapshot(database || repository.exportLegacyDatabase({ metadataOnly: true }));
        },
        close: () => watcher?.close(),
    };
}

module.exports = { createLiveCharacterFiles, metadataSnapshot, mergePendingLiveDatabase, createLiveFileRecovery };
