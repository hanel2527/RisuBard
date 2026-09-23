'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function checksum(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function checksumFile(filePath) {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = fs.openSync(filePath, 'r');
    try {
        let bytesRead;
        do {
            bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function resolveInside(root, relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
        throw new Error('Canonical file path must be a non-empty relative path');
    }
    const rootPath = path.resolve(root);
    const target = path.resolve(rootPath, relativePath);
    const prefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
    if (target !== rootPath && !target.startsWith(prefix)) {
        throw new Error('Canonical file path escapes the data root');
    }
    return target;
}

function fsyncDirectory(directory) {
    let fd;
    try {
        fd = fs.openSync(directory, 'r');
        fs.fsyncSync(fd);
    } catch (error) {
        if (process.platform !== 'win32') throw error;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function writeSynced(filePath, data) {
    const fd = fs.openSync(filePath, 'wx', 0o600);
    try {
        let offset = 0;
        while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

function copySynced(source, destination) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(destination, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function replaceAtomic(target, data) {
    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true });
    const temp = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
    writeSynced(temp, data);
    try {
        fs.renameSync(temp, target);
        fsyncDirectory(directory);
    } catch (error) {
        try { fs.unlinkSync(temp); } catch {}
        throw error;
    }
}

function preserveBackup(target) {
    if (!fs.existsSync(target)) return;
    const backup = `${target}.bak`;
    const temp = `${backup}.${crypto.randomUUID()}.tmp`;
    copySynced(target, temp);
    // A copied package may have a sidecar for the previous backup revision.
    // Backups are historical bytes, not a checksummed canonical write. Never
    // leave that old checksum attached to the replacement backup.
    fs.rmSync(`${backup}.sha256`, { force: true });
    fs.renameSync(temp, backup);
    fsyncDirectory(path.dirname(backup));
}

function atomicWriteFile(root, relativePath, value, options = {}) {
    const target = resolveInside(root, relativePath);
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (options.validate && options.validate(data) !== true) {
        throw new Error(`Canonical file validation failed: ${relativePath}`);
    }

    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true });
    const temp = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
    writeSynced(temp, data);
    const staged = fs.readFileSync(temp);
    const digest = checksum(data);
    if (checksum(staged) !== digest) {
        fs.unlinkSync(temp);
        throw new Error(`Canonical file checksum verification failed: ${relativePath}`);
    }

    try {
        preserveBackup(target);
        fs.renameSync(temp, target);
        replaceAtomic(`${target}.sha256`, Buffer.from(`${digest}\n`, 'utf8'));
        fsyncDirectory(directory);
    } catch (error) {
        try { fs.unlinkSync(temp); } catch {}
        throw error;
    }
    return { path: target, checksum: digest, bytes: data.length };
}

function atomicWriteJson(root, relativePath, value, options = {}) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return atomicWriteFile(root, relativePath, bytes, {
        ...options,
        validate: (candidate) => {
            let parsed;
            try { parsed = JSON.parse(candidate.toString('utf8')); } catch { return false; }
            return options.validate ? options.validate(parsed) === true : true;
        },
    });
}

function readVerifiedJson(root, relativePath, options = {}) {
    const target = resolveInside(root, relativePath);
    const bytes = fs.readFileSync(target);
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (options.validate && options.validate(parsed) !== true) {
        throw new Error(`Canonical file validation failed: ${relativePath}`);
    }
    const checksumPath = `${target}.sha256`;
    if (fs.existsSync(checksumPath)) {
        const expected = fs.readFileSync(checksumPath, 'utf8').trim();
        if (expected && checksum(bytes) !== expected) {
            if (!options.acceptExternalChanges) {
                throw new Error(`Canonical file checksum mismatch: ${relativePath}`);
            }
            replaceAtomic(checksumPath, Buffer.from(`${checksum(bytes)}\n`, 'utf8'));
        }
    }
    return parsed;
}

function writeJournal(journalPath, value) {
    replaceAtomic(journalPath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

function publishTransaction(root, journal, options = {}) {
    let published = 0;
    let skipped = 0;
    for (const entry of journal.entries) {
        if (entry.action === 'delete-character') {
            const target = characterDeletionPath(root, entry.path);
            fs.rmSync(target, { recursive: true, force: true });
            fsyncDirectory(path.dirname(target));
            published += 1;
            if (options.failAfterPublish === published) throw new Error('simulated crash during transaction publish');
            continue;
        }
        if (entry.action === 'move') {
            const source = resolveInside(root, entry.path);
            const destination = resolveInside(root, entry.destination);
            if (!fs.existsSync(source)) {
                if (!fs.existsSync(destination)) {
                    throw new Error(`Transaction move is missing for ${entry.path}`);
                }
                skipped += 1;
                continue;
            }
            if (fs.existsSync(destination)) {
                throw new Error(`Transaction move destination already exists: ${entry.destination}`);
            }
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.renameSync(source, destination);
            fsyncDirectory(path.dirname(source));
            fsyncDirectory(path.dirname(destination));
            published += 1;
            if (options.failAfterPublish === published) throw new Error('simulated crash during transaction publish');
            continue;
        }
        const target = resolveInside(root, entry.path);
        if (matchesChecksum(target, entry.checksum)) {
            // The bytes may have been edited externally, or a crash may have
            // occurred between publishing the file and its checksum sidecar.
            if (!matchesStoredChecksum(target, entry.checksum)) {
                replaceAtomic(`${target}.sha256`, Buffer.from(`${entry.checksum}\n`, 'utf8'));
            }
            skipped += 1;
            continue;
        }
        if (!fs.existsSync(entry.staged)) {
            throw new Error(`Transaction stage is missing for ${entry.path}`);
        }
        preserveBackup(target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(entry.staged, target);
        replaceAtomic(`${target}.sha256`, Buffer.from(`${entry.checksum}\n`, 'utf8'));
        fsyncDirectory(path.dirname(target));
        published += 1;
        if (options.failAfterPublish === published) throw new Error('simulated crash during transaction publish');
    }
    return { published, skipped };
}

function cleanupJournal(journalPath, stageDir) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.rmSync(journalPath, { force: true });
    fsyncDirectory(path.dirname(journalPath));
}

function matchesChecksum(target, digest) {
    try {
        return checksumFile(target) === digest;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

function matchesStoredChecksum(target, digest) {
    try {
        if (!fs.existsSync(target)) return false;
        const checksumPath = `${target}.sha256`;
        return fs.readFileSync(checksumPath, 'utf8').trim() === digest;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

function refreshChecksum(root, relativePath) {
    const target = resolveInside(root, relativePath);
    const digest = checksumFile(target);
    replaceAtomic(`${target}.sha256`, Buffer.from(`${digest}\n`, 'utf8'));
    return digest;
}

function assertUnchangedPreconditions(root, entries) {
    for (const entry of entries) {
        const target = resolveInside(root, entry.path);
        if (matchesChecksum(target, entry.checksum)) continue;
        const error = new Error(`Canonical file changed during transaction: ${entry.path}`);
        error.code = 'CANONICAL_FILES_CHANGED';
        throw error;
    }
}

function characterDeletionPath(root, relativePath) {
    const target = resolveInside(root, relativePath);
    const parts = path.relative(path.resolve(root), target).split(path.sep);
    if (parts.length !== 2 || parts[0] !== 'characters' || !parts[1] || parts[1].startsWith('.')) {
        throw new Error('Deletion requires one character directory');
    }
    let current = path.resolve(root);
    for (const part of parts) {
        current = path.join(current, part);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Character deletion uses a symbolic link');
    }
    return target;
}

function commitTransaction(root, operations, options = {}) {
    if (!Array.isArray(operations) || operations.length === 0) {
        return { committed: 0, published: 0, skipped: 0, stagedBytes: 0 };
    }
    const prepared = operations.map((operation, operationIndex) => {
        if (operation.deleteCharacter === true) {
            characterDeletionPath(root, operation.path);
            if (operation.moveTo || operation.sourcePath || operation.data !== undefined) throw new Error('Deletion cannot include file data');
            return { action: 'delete-character', path: operation.path, unchanged: false };
        }
        if (operation.moveTo) {
            if (operation.data !== undefined || operation.sourcePath) {
                throw new Error(`Transaction move cannot include file data: ${operation.path}`);
            }
            const source = resolveInside(root, operation.path);
            const destination = resolveInside(root, operation.moveTo);
            const destinationClearedEarlier = operation.destinationClearedByTransaction === true
                && operations.slice(0, operationIndex).some(previous => {
                    if (!previous.moveTo) return false;
                    const cleared = resolveInside(root, previous.path);
                    return destination === cleared || destination.startsWith(`${cleared}${path.sep}`);
                });
            if (fs.existsSync(destination) && !destinationClearedEarlier) {
                throw new Error(`Transaction move destination already exists: ${operation.moveTo}`);
            }
            return {
                action: 'move',
                path: operation.path,
                destination: operation.moveTo,
                unchanged: !operation.sourceCreatedByTransaction && !fs.existsSync(source),
            };
        }
        const target = resolveInside(root, operation.path);
        let data;
        let digest;
        let sourcePath;
        if (operation.sourcePath) {
            sourcePath = resolveInside(root, path.relative(root, operation.sourcePath));
            if (operation.validate) {
                throw new Error(`Transaction file validation is unsupported: ${operation.path}`);
            }
            digest = checksumFile(sourcePath);
        } else {
            data = Buffer.isBuffer(operation.data) ? operation.data : Buffer.from(operation.data);
            if (operation.validate && operation.validate(data) !== true) {
                throw new Error(`Transaction validation failed: ${operation.path}`);
            }
            digest = checksum(data);
        }
        return { action: 'replace', path: operation.path, data, sourcePath, checksum: digest, unchanged: matchesStoredChecksum(target, digest) };
    });
    const unchanged = prepared.filter(entry => entry.unchanged);
    const pending = prepared.filter(entry => !entry.unchanged);
    if (pending.length === 0) {
        assertUnchangedPreconditions(root, unchanged.filter(entry => entry.action !== 'move'));
        return {
            committed: operations.length,
            published: 0,
            skipped: unchanged.length,
            stagedBytes: 0,
        };
    }
    const journalDir = resolveInside(root, '.journal');
    fs.mkdirSync(journalDir, { recursive: true });
    const id = crypto.randomUUID();
    const stageDir = path.join(journalDir, `${id}.stage`);
    fs.mkdirSync(stageDir, { recursive: true });
    const entries = pending.map((operation, index) => {
        if (operation.action === 'delete-character') return { action: operation.action, path: operation.path };
        if (operation.action === 'move') {
            return { action: 'move', path: operation.path, destination: operation.destination };
        }
        const staged = path.join(stageDir, `${index}.data`);
        if (operation.sourcePath) {
            copySynced(operation.sourcePath, staged);
        } else {
            writeSynced(staged, operation.data);
        }
        if (checksumFile(staged) !== operation.checksum) throw new Error(`Transaction checksum failed: ${operation.path}`);
        return { action: 'replace', path: operation.path, staged, checksum: operation.checksum };
    });
    fsyncDirectory(stageDir);
    try {
        assertUnchangedPreconditions(root, unchanged.filter(entry => entry.action !== 'move'));
    } catch (error) {
        fs.rmSync(stageDir, { recursive: true, force: true });
        fsyncDirectory(journalDir);
        throw error;
    }
    const journalPath = path.join(journalDir, `${id}.json`);
    const journal = { schemaVersion: 1, id, state: 'prepared', createdAt: Date.now(), entries };
    writeJournal(journalPath, journal);
    const stagedBytes = entries.reduce((total, entry) => (
        entry.action === 'move' || entry.action === 'delete-character' ? total : total + fs.statSync(entry.staged).size
    ), 0);
    const published = publishTransaction(root, journal, options);
    cleanupJournal(journalPath, stageDir);
    return {
        committed: operations.length,
        published: published.published,
        skipped: unchanged.length + published.skipped,
        stagedBytes,
    };
}

function recoverTransactions(root) {
    const journalDir = resolveInside(root, '.journal');
    if (!fs.existsSync(journalDir)) return { recovered: 0 };
    const journals = fs.readdirSync(journalDir).filter(name => name.endsWith('.json')).sort();
    let recovered = 0;
    for (const name of journals) {
        const journalPath = path.join(journalDir, name);
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        const stageDir = path.join(journalDir, `${journal.id}.stage`);
        publishTransaction(root, journal);
        cleanupJournal(journalPath, stageDir);
        recovered += 1;
    }
    return { recovered };
}

function moveToTrash(root, relativePath) {
    const source = resolveInside(root, relativePath);
    if (!fs.existsSync(source)) throw new Error(`Canonical file does not exist: ${relativePath}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = resolveInside(root, path.join('trash', stamp, relativePath));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    for (const suffix of ['.sha256', '.bak']) {
        if (fs.existsSync(`${source}${suffix}`)) fs.renameSync(`${source}${suffix}`, `${destination}${suffix}`);
    }
    fsyncDirectory(path.dirname(source));
    fsyncDirectory(path.dirname(destination));
    return destination;
}

module.exports = {
    atomicWriteFile,
    atomicWriteJson,
    checksum,
    commitTransaction,
    moveToTrash,
    readVerifiedJson,
    refreshChecksum,
    recoverTransactions,
    resolveInside,
};
