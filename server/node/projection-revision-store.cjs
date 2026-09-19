'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson, readVerifiedJson } = require('./file-store.cjs');

const REVISION_PATH = 'cache/canonical-projection-revision.json';
const valid = value => value?.schemaVersion === 1
    && typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision);

// Acceptance is derived metadata, not a second source of user data. An absent
// or stale record causes the existing canonical reconciliation path to run.
// Old runtimes retain their KV record and likewise reconcile newer file writes.
function createProjectionRevisionStore({ dataRoot, readLegacyRevision }) {
    const target = path.join(dataRoot, REVISION_PATH);
    return {
        readAcceptedRevision() {
            if (!fs.existsSync(target)) return readLegacyRevision?.() || null;
            try {
                // A crash between data and checksum publication must not accept
                // an unchecked record. Do not repair it or restore an old backup.
                if (!fs.existsSync(`${target}.sha256`)
                    || !/^[a-f0-9]{64}$/.test(fs.readFileSync(`${target}.sha256`, 'utf8').trim())) return null;
                return readVerifiedJson(dataRoot, REVISION_PATH, { validate: valid }).revision;
            } catch {
                return null;
            }
        },
        writeAcceptedRevision(revision) {
            atomicWriteJson(dataRoot, REVISION_PATH, { schemaVersion: 1, revision }, { validate: valid });
        },
    };
}

module.exports = { createProjectionRevisionStore };
