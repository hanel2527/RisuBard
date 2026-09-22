'use strict';

// Compatibility facade for the legacy server routes. Canonical bytes live in
// the file-native KV manifest/object store; no database is opened at runtime.
const { createFileKv } = require('./file-kv.cjs');
const { resolveDataRoot } = require('./data-root.cjs');
const { createUserDataRepository } = require('./user-data-repository.cjs');
const { attachCompatibilityCache } = require('./compatibility-cache.cjs');
const { migrateLegacySqlite } = require('./legacy-sqlite-import.cjs');
const fs = require('fs');
const path = require('path');

const dataRoot = resolveDataRoot();
const store = createFileKv({ dataRoot });
if (!store.kvGet('database/database.bin') && fs.existsSync(path.join(dataRoot, 'risuai.db'))) {
    migrateLegacySqlite({ dataRoot, store, sqlitePath: path.join(dataRoot, 'risuai.db') });
}
const repository = createUserDataRepository({
    dataRoot,
    allowDirectoryMapping: true,
    maintainDirectoryNames: true,
});
const compatibilityCache = attachCompatibilityCache({
    store, repository, dataRoot,
    enabled: process.env.RISUBARD_DEFER_DATABASE !== '0',
    canInvalidate: () => !fs.existsSync(path.join(dataRoot, 'risuai.db')),
});

module.exports = { ...store, repository, compatibilityCache };
