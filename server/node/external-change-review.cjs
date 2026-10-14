'use strict';

// Review of canonical files edited outside RisuBard while the app is open.
// Character metadata and global lorebooks whose bytes no longer match their
// .sha256 sidecar are compared with the in-memory app state, so the user can
// accept the external version or keep the app version (Godot-style reload).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { refreshChecksum } = require('./file-store.cjs');

const TEXT_LIMIT = 200_000;
const IGNORED_FIELDS = new Set(['chats', 'chatPage']);

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Same format as the repository's startup validation message.
function describeJsonError(text, error) {
    const reason = String(error?.message || 'invalid JSON').replace(/\s*in JSON at position \d+.*$/, '');
    const match = /at position (\d+)/.exec(String(error?.message || ''));
    const position = match ? Math.min(Number(match[1]), text.length) : text.length;
    const before = text.slice(0, position);
    const line = before.split('\n').length;
    const column = position - before.lastIndexOf('\n');
    return `line ${line}, column ${column}: ${reason}`;
}

// Read one canonical file without blessing its checksum. By default only files
// whose bytes no longer match their .sha256 sidecar are returned.
function readEdited(root, relativePath, { all = false } = {}) {
    const target = path.join(root, relativePath);
    if (!fs.existsSync(target)) return null;
    const checksumPath = `${target}.sha256`;
    const bytes = fs.readFileSync(target);
    if (!all) {
        if (!fs.existsSync(checksumPath)) return null;
        const expected = fs.readFileSync(checksumPath, 'utf8').trim();
        if (!expected || sha256(bytes) === expected) return null;
    }
    const text = bytes.toString('utf8');
    try {
        const value = JSON.parse(text);
        if (!isPlainObject(value)) return { path: relativePath, error: 'JSON root must be an object' };
        return { path: relativePath, value };
    } catch (error) {
        return { path: relativePath, error: describeJsonError(text, error) };
    }
}

const textOf = value => {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
    return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n…` : text;
};

function diffLore(before = [], after = []) {
    const key = (entry, index) => entry?.id ?? `${entry?.comment ?? ''}#${index}`;
    const beforeMap = new Map(before.map((entry, index) => [key(entry, index), entry]));
    const afterMap = new Map(after.map((entry, index) => [key(entry, index), entry]));
    const label = entry => entry?.comment || entry?.key || '(이름 없음)';
    const added = [];
    const removed = [];
    const changed = [];
    for (const [id, entry] of afterMap) {
        const old = beforeMap.get(id);
        if (!old) added.push({ id, name: label(entry), after: textOf(entry.content ?? '') });
        else if (!same(old, entry)) {
            const fields = [...new Set([...Object.keys(old), ...Object.keys(entry)])].filter(field => !same(old[field], entry[field]));
            changed.push({ id, name: label(entry), fields, before: textOf(old.content ?? ''), after: textOf(entry.content ?? '') });
        }
    }
    for (const [id, entry] of beforeMap) if (!afterMap.has(id)) removed.push({ id, name: label(entry), before: textOf(entry.content ?? '') });
    return { added, removed, changed };
}

function diffCharacter(app, external) {
    const fields = [];
    let lore = null;
    for (const field of new Set([...Object.keys(app), ...Object.keys(external)])) {
        if (IGNORED_FIELDS.has(field) || same(app[field], external[field])) continue;
        if (field === 'globalLore') {
            lore = diffLore(app.globalLore, external.globalLore);
            continue;
        }
        fields.push({ field, before: textOf(app[field]), after: textOf(external[field]) });
    }
    return { fields, lore };
}

function createExternalChangeReview({ repository, dataRoot }) {
    let cache = null;

    // Externally edited character and global lorebook files, with their parsed values.
    function collect(options) {
        const index = repository.loadSidebarIndex();
        const characters = [];
        for (const summary of index.characters || []) {
            const directory = repository.characterDirectoryPath(summary.id);
            if (!directory) continue;
            const edited = readEdited(dataRoot, path.join(directory, 'metadata.json').split(path.sep).join('/'), options);
            if (edited) characters.push({ id: summary.id, ...edited });
        }
        const lorebooks = [];
        for (const id of index.collections?.loreBook || []) {
            const edited = readEdited(dataRoot, repository.collectionItemPath('lorebooks', id).split(path.sep).join('/'), options);
            if (edited) lorebooks.push({ id, ...edited });
        }
        return { characters, lorebooks };
    }

    // Summarize differences between the app database and the edited files.
    function inspect(revision, appDb) {
        if (cache && cache.revision === revision) return cache.review;
        let review = compare(revision, appDb, collect());
        // A tool may rewrite the checksum together with the file. Compare every
        // character and lorebook with the app state when no sidecar mismatches.
        if (!review.changes.length && !review.errors.length) review = compare(revision, appDb, collect({ all: true }));
        cache = { revision, review };
        return review;
    }

    function compare(revision, appDb, files) {
        const changes = [];
        const errors = [];
        for (const file of files.characters) {
            if (file.error) { errors.push({ path: file.path, error: file.error }); continue; }
            const app = appDb?.characters?.find(character => character.chaId === file.value.chaId);
            if (!app) continue;
            const diff = diffCharacter(app, file.value);
            if (!diff.fields.length && !diff.lore) continue;
            changes.push({ kind: 'character', id: file.value.chaId, name: file.value.name || app.name || '', path: file.path, ...diff });
        }
        for (const file of files.lorebooks) {
            if (file.error) { errors.push({ path: file.path, error: file.error }); continue; }
            const appIndex = (repository.loadSidebarIndex().collections?.loreBook || []).indexOf(file.id);
            const app = appDb?.loreBook?.[appIndex];
            if (!app || same(app, file.value)) continue;
            const fields = [...new Set([...Object.keys(app), ...Object.keys(file.value)])]
                .filter(field => field !== 'data' && !same(app[field], file.value[field]))
                .map(field => ({ field, before: textOf(app[field]), after: textOf(file.value[field]) }));
            const lore = same(app.data, file.value.data) ? null : diffLore(app.data, file.value.data);
            changes.push({ kind: 'lorebook', id: file.id, index: appIndex, name: file.value.name || app.name || '', path: file.path, fields, lore });
        }
        // Only files that differ from the app (or cannot be parsed) take part in a decision.
        const relevant = new Set([...changes.map(change => change.path), ...errors.map(error => error.path)]);
        return {
            revision, changes, errors,
            files: {
                characters: files.characters.filter(file => relevant.has(file.path)),
                lorebooks: files.lorebooks.filter(file => relevant.has(file.path)),
            },
        };
    }

    // Replace the reviewed entities in a stripped database with their external versions.
    function applyExternal(appDb, review) {
        const next = structuredClone(appDb);
        for (const file of review.files.characters) {
            if (file.error) continue;
            const index = next.characters.findIndex(character => character.chaId === file.value.chaId);
            if (index < 0) continue;
            const { chats, chatPage } = next.characters[index];
            const incoming = Object.fromEntries(Object.entries(file.value).filter(([field]) => !IGNORED_FIELDS.has(field)));
            next.characters[index] = { ...incoming, chats, chatPage };
        }
        const order = repository.loadSidebarIndex().collections?.loreBook || [];
        for (const file of review.files.lorebooks) {
            if (file.error) continue;
            const index = order.indexOf(file.id);
            if (index >= 0 && next.loreBook?.[index]) next.loreBook[index] = file.value;
        }
        return next;
    }

    // Keep a copy of discarded external files before the app version replaces them.
    function backup(review) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = path.join(dataRoot, 'trash', `external-changes-${stamp}`);
        for (const file of [...review.files.characters, ...review.files.lorebooks]) {
            const source = path.join(dataRoot, file.path);
            if (!fs.existsSync(source)) continue;
            const destination = path.join(target, file.path);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(source, destination);
        }
        return path.relative(dataRoot, target).split(path.sep).join('/');
    }

    // The reviewed bytes become the transaction baseline, so the decided
    // version can replace them (the commit refuses to overwrite unseen edits).
    function acknowledge(review) {
        for (const file of [...review.files.characters, ...review.files.lorebooks]) {
            if (fs.existsSync(path.join(dataRoot, file.path))) refreshChecksum(dataRoot, file.path);
        }
    }

    // Response payload: diff details without the parsed file bodies.
    const publicReview = review => review && {
        revision: review.revision,
        changes: review.changes,
        errors: review.errors,
        hasDetails: review.changes.length > 0 || review.errors.length > 0,
    };

    return { inspect, applyExternal, backup, acknowledge, publicReview, clear: () => { cache = null; } };
}

module.exports = { createExternalChangeReview, diffCharacter, diffLore, readEdited };
