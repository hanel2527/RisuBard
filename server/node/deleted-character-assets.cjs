'use strict';
const { collectNestedAssetReferences } = require('./orphan-cleanup.cjs');

function reclaimDeletedCharacterAssets({ candidates, database, listKeys, read, remove }) {
    if (!candidates?.length) return { count: 0, reclaimed: 0 };
    if (!Array.isArray(database?.characters)) throw new Error('Complete database required for asset cleanup');
    for (const character of database.characters) {
        if (character.coldstorage || character.chats?.some(chat => chat._stub || chat.type === 'remote')) {
            throw new Error('Unloaded character data prevents asset cleanup');
        }
    }
    const referenced = collectNestedAssetReferences(database);
    // Complete every read and validation before removing any key.
    for (const key of listKeys('cache/plugin-storage/')) {
        if (!key.endsWith('.json')) continue;
        const bytes = read(key);
        if (!bytes) throw new Error('Plugin storage unavailable during asset cleanup');
        collectNestedAssetReferences(JSON.parse(bytes.toString('utf8')), referenced);
    }
    const keys = [...new Set(candidates)]
        .filter(name => /^[A-Za-z0-9._-]+$/.test(name) && !referenced.has(name))
        .map(name => 'assets/' + name);
    return keys.length ? remove(keys) : { count: 0, reclaimed: 0 };
}

module.exports = { reclaimDeletedCharacterAssets };
