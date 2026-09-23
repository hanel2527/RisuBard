'use strict';

const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { encodeCanonicalBackupName } = require('./canonical-backup-name.cjs');
const { DIRECTORY_INDEX, createCharacterDirectoryResolver } = require('./character-directories.cjs');
const { collisionKey } = require('./friendly-paths.cjs');
const { resolveInside } = require('./file-store.cjs');

const CANONICAL_BACKUP_DIRECTORIES = [
    'settings', 'secrets', 'presets', 'modules', 'personas', 'lorebooks',
    'characters', 'index', 'risubard', 'trash', 'logs', 'request-logs',
    'model-jobs',
];

async function listCanonicalBackupEntries(dataRoot) {
    const root = path.resolve(dataRoot);
    if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Canonical backup root uses a symbolic link');
    const directories = createCharacterDirectoryResolver(root);
    const mapping = directories.snapshot();
    function mappingRevision() {
        return [DIRECTORY_INDEX, `${DIRECTORY_INDEX}.sha256`].map(relative => {
            try {
                const stat = syncFs.statSync(directories.safePath(relative), { bigint: true });
                return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
                return 'missing';
            }
        }).join('|');
    }
    const beforeRevision = mappingRevision();
    const beforeMapping = JSON.stringify(mapping);
    const retired = new Set();
    for (const character of mapping.characters) {
        if (character.directory !== character.id) retired.add(collisionKey(`characters/${character.id}`));
        for (const chat of character.chats) {
            if (chat.directory !== chat.id) retired.add(collisionKey(`characters/${character.directory}/chats/${chat.id}`));
        }
    }
    const entries = [];
    async function walk(relativeDirectory, optionalRoot = false, checkedStat) {
        const absolute = resolveInside(root, relativeDirectory);
        let stat = checkedStat;
        try { stat ||= await fs.lstat(absolute); }
        catch (error) {
            if (optionalRoot && error?.code === 'ENOENT') return;
            throw error;
        }
        if (stat.isSymbolicLink()) throw new Error('Canonical backup path uses a symbolic link');
        if (!stat.isDirectory()) throw new Error('Canonical backup root is not a directory');
        const children = await fs.readdir(absolute, { withFileTypes: true });
        const names = new Set();
        for (const child of children) {
            if (child.name.includes('\\') || child.name.includes('/') || child.name === '.' || child.name === '..') throw new Error('Unsafe canonical backup path');
            if (child.isSymbolicLink()) throw new Error('Canonical backup path uses a symbolic link');
            if (child.name.endsWith('.tmp') || child.name.endsWith('.sha256')) continue;
            const key = collisionKey(child.name);
            if (names.has(key)) throw new Error('Canonical backup filename collision');
            names.add(key);
            const relativePath = path.join(relativeDirectory, child.name);
            const portable = relativePath.split(path.sep).join('/');
            if (retired.has(collisionKey(portable))) {
                if (!child.isDirectory()) throw new Error('Retired canonical directory is not a directory');
                continue;
            }
            // Parents were checked when entered; avoid synchronous ancestor stats per file.
            const sourcePath = resolveInside(root, relativePath);
            const current = await fs.lstat(sourcePath);
            if (current.isSymbolicLink()) throw new Error('Canonical backup path uses a symbolic link');
            if (current.isDirectory()) await walk(relativePath, false, current);
            else if (current.isFile()) {
                entries.push({
                    kind: 'canonical', sourcePath,
                    // Flat reversible names remain opaque to legacy importers.
                    backupName: encodeCanonicalBackupName(portable),
                    sortKey: `risubard-data/${portable}`, size: current.size,
                });
            } else throw new Error('Unsupported canonical backup entry');
        }
    }
    for (const directory of CANONICAL_BACKUP_DIRECTORIES) await walk(directory, true);
    const afterMapping = JSON.stringify(directories.refresh());
    if (beforeMapping !== afterMapping || beforeRevision !== mappingRevision()) {
        throw new Error('Character directory mapping changed during canonical backup inventory');
    }
    // This validates inventory topology, not a byte snapshot of subsequent file reads.
    return entries.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
}

module.exports = { CANONICAL_BACKUP_DIRECTORIES, listCanonicalBackupEntries };
