'use strict';

const NON_ROOT_COLLECTIONS = ['/characters', '/modules', '/personas', '/loreBook'];

function inspectOperations(operations) {
    const result = { hasBotPresets: false, hasRootSettings: false, unsafe: false };
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
        observe(key, operations) {
            const next = inspectOperations(operations);
            const previous = pending.get(key) || { hasBotPresets: false, hasRootSettings: false, unsafe: false };
            pending.set(key, {
                hasBotPresets: previous.hasBotPresets || next.hasBotPresets,
                hasRootSettings: previous.hasRootSettings || next.hasRootSettings,
                unsafe: previous.unsafe || next.unsafe,
            });
        },
        take(key) {
            const state = pending.get(key);
            pending.delete(key);
            if (!state || state.unsafe || !state.hasBotPresets) return null;
            return state.hasRootSettings ? 'botPresetState' : 'botPresets';
        },
        clear(key) {
            pending.delete(key);
        },
    };
}

module.exports = { createDirectWriteTracker, patchCollection };
