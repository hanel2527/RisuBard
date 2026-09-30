'use strict';
const { performance } = require('node:perf_hooks');
const { createUserDataRepository } = require('./user-data-repository.cjs');
const { createFileKv } = require('./file-kv.cjs');
const { writeCanonicalProjection } = require('./canonical-projection-writer.cjs');
const { reclaimDeletedCharacterAssets } = require('./deleted-character-assets.cjs');
const { reportImportProgress } = require('./import-progress.cjs');
function createRepository(dataRoot) {
    return createUserDataRepository({
        dataRoot, allowDirectoryMapping: true, maintainDirectoryNames: true,
        liveExternalEditing: true, newCharacterPackages: true,
    });
}

function persistProjection(input) {
    let stage = 'external-change-check';
    try {
        reportImportProgress('check-files');
        const repository = createRepository(input.dataRoot);
        if (repository.getProjectionRevision() !== input.expectedRevision) {
            const error = new Error('Canonical entity files changed outside RisuBard before projection save');
            error.code = 'CANONICAL_FILES_CHANGED';
            throw error;
        }
        stage = 'transaction';
        reportImportProgress('canonical-files');
        const startedAt = performance.now();
        const write = writeCanonicalProjection({
            repository, database: input.database, directCollection: input.directCollection,
            preserveCharacterLayout: input.preserveCharacterLayout,
        });
        const transactionMs = performance.now() - startedAt;
        stage = 'character-assets';
        reportImportProgress('character-assets');
        const assetsStartedAt = performance.now();
        const store = createFileKv({ dataRoot: input.dataRoot });
        store.characterAssets.sync(input.database);
        const assetSyncMs = performance.now() - assetsStartedAt;
        stage = 'revision-accept';
        reportImportProgress('verify-save');
        const revision = repository.getProjectionRevision();
        return { write, transactionMs, assetSyncMs, revision };
    } catch (error) {
        if (error && typeof error === 'object') error.importStage = stage;
        throw error;
    }
}

function rollbackAssets(input) {
    const repository = createRepository(input.dataRoot);
    const store = createFileKv({ dataRoot: input.dataRoot });
    reportImportProgress('cleanup-assets', 0, input.keys.length);
    const cleanup = reclaimDeletedCharacterAssets({
        candidates: input.keys.map(key => key.slice('assets/'.length)),
        database: repository.exportLegacyDatabase(),
        listKeys: store.kvList, read: store.kvGet, remove: store.kvDelManyAndCollect,
    });
    store.kvDelManyAndCollect([input.marker]);
    reportImportProgress('cleanup-assets', input.keys.length, input.keys.length);
    return cleanup;
}
module.exports = { persistProjection, rollbackAssets };
