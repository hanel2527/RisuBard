'use strict';

const NON_ROOT_COLLECTIONS = ['/characters', '/modules', '/personas', '/loreBook'];

function emptyState() {
    return { hasBotPresets: false, hasRootSettings: false, unsafe: false, chats: new Map(), characterIds: new Set() };
}

function addChat(state, characterId, chatId) {
    if (typeof characterId !== 'string' || !characterId.trim() || typeof chatId !== 'string' || !chatId.trim()) {
        state.unsafe = true;
        return;
    }
    state.characterIds.add(characterId);
    state.chats.set(JSON.stringify([characterId, chatId]), { characterId, chatId });
}

function inspectOperations(operations, database) {
    const result = emptyState();
    if (!Array.isArray(operations) || operations.length === 0) {
        result.unsafe = true;
        return result;
    }
    for (const operation of operations) {
        if (!operation || typeof operation !== 'object'
            || !['add', 'replace', 'remove'].includes(operation.op)
            || typeof operation.path !== 'string'
            || !operation.path.startsWith('/')
            || Object.prototype.hasOwnProperty.call(operation, 'from')) {
            result.unsafe = true;
            continue;
        }
        if (operation.path === '/botPresets' || operation.path.startsWith('/botPresets/')) {
            result.hasBotPresets = true;
            continue;
        }
        const characterField = operation.path.match(/^\/characters\/(0|[1-9]\d*)\/([^/]+)(?:\/|$)/);
        if (characterField && database) {
            const character = database.characters?.[Number(characterField[1])];
            const characterId = character?.chaId || character?.id;
            const field = characterField[2];
            if (typeof characterId !== 'string' || !characterId.trim() || ['chaId', 'id'].includes(field)) {
                result.unsafe = true;
            } else if (field === 'chats') {
                const chatField = operation.path.match(/^\/characters\/\d+\/chats\/(0|[1-9]\d*)\/([^/]+)(?:\/|$)/);
                if (!chatField || chatField[2] === 'id') result.unsafe = true;
                else addChat(result, characterId, character.chats?.[Number(chatField[1])]?.id);
            } else {
                result.characterIds.add(characterId);
            }
            continue;
        }
        if (NON_ROOT_COLLECTIONS.some(prefix => operation.path === prefix || operation.path.startsWith(`${prefix}/`))) {
            result.unsafe = true;
            continue;
        }
        result.hasRootSettings = true;
    }
    return result;
}

function patchCollection(operations) {
    const state = inspectOperations(operations);
    if (state.unsafe || !state.hasBotPresets) return null;
    return state.hasRootSettings ? 'botPresetState' : 'botPresets';
}

function createDirectWriteTracker() {
    const pending = new Map();
    return {
        observe(key, operations, database) {
            const next = inspectOperations(operations, database);
            const previous = pending.get(key) || emptyState();
            pending.set(key, {
                hasBotPresets: previous.hasBotPresets || next.hasBotPresets,
                hasRootSettings: previous.hasRootSettings || next.hasRootSettings,
                unsafe: previous.unsafe || next.unsafe,
                chats: new Map([...previous.chats, ...next.chats]),
                characterIds: new Set([...previous.characterIds, ...next.characterIds]),
            });
        },
        observeChat(key, characterId, chatId) {
            const state = pending.get(key) || emptyState();
            addChat(state, characterId, chatId);
            pending.set(key, state);
        },
        take(key) {
            const state = pending.get(key);
            pending.delete(key);
            if (!state || state.unsafe) return null;
            if (state.chats.size > 0 && !state.hasBotPresets) {
                return { kind: 'chatState', chats: [...state.chats.values()],
                    characterIds: [...state.characterIds], includeRootSettings: state.hasRootSettings };
            }
            if (state.characterIds.size > 0) return null;
            if (!state.hasBotPresets) return state.hasRootSettings ? 'botPresetState' : null;
            return state.hasRootSettings ? 'botPresetState' : 'botPresets';
        },
        clear(key) {
            pending.delete(key);
        },
    };
}

module.exports = { createDirectWriteTracker, patchCollection };
