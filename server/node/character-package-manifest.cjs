'use strict';

const { collisionKey } = require('./friendly-paths.cjs');

function createCharacterPackageManifest(mapping) {
    return {
        schemaVersion: 1,
        active: true,
        characterId: mapping.id,
        directory: mapping.directory,
        chats: mapping.chats.map(chat => ({ id: chat.id, directory: chat.directory })),
    };
}

function validateCharacterPackageManifest(value, mapping) {
    const expected = createCharacterPackageManifest(mapping);
    const sameChats = Array.isArray(value?.chats)
        && value.chats.length === expected.chats.length
        && value.chats.every((chat, index) => {
            const wanted = expected.chats[index];
            return chat?.id === wanted.id && chat?.directory === wanted.directory;
        });
    if (value?.schemaVersion !== 1
        || value.active !== true
        || value.characterId !== expected.characterId
        || collisionKey(value.directory) !== collisionKey(expected.directory)
        || value.directory !== expected.directory
        || !sameChats) {
        throw new Error('Character package identity does not match its directory mapping');
    }
    return value;
}

module.exports = { createCharacterPackageManifest, validateCharacterPackageManifest };
