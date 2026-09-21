'use strict';

const path = require('node:path');
const MAX_BYTES = 120;
const collisionKey = value => value.normalize('NFC').toUpperCase().toLowerCase();
function truncate(value, max = MAX_BYTES) {
    let result = '';
    for (const char of value) {
        if (Buffer.byteLength(result + char, 'utf8') > max) break;
        result += char;
    }
    return result;
}
function sanitizeSegment(value) {
    let name = String(value ?? '').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').trim().replace(/[. ]+$/g, '');
    if (!name || name === '.' || name === '..') name = 'Untitled';
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
    return truncate(name).replace(/[. ]+$/g, '') || 'Untitled';
}
function numberedName(name, number, file) {
    const raw = String(name ?? '').normalize('NFC');
    const suffix = number > 1 ? ` (${number})` : '';
    // Extensions use their own budget so truncating a long basename never drops .png, etc.
    const rawExtension = file ? path.posix.extname(raw.replace(/\\/g, '/')) : '';
    const extension = rawExtension && /^\.[A-Za-z0-9]{1,16}$/.test(rawExtension) ? rawExtension : '';
    const stem = sanitizeSegment(extension ? raw.slice(0, -extension.length) : raw);
    const shortened = truncate(stem, MAX_BYTES - Buffer.byteLength(suffix + extension)).replace(/[. ]+$/g, '') || 'Untitled';
    return shortened + suffix + extension;
}
function allocateSegment(name, occupied = new Set(), file = false) {
    const used = new Set([...occupied].map(collisionKey));
    for (let number = 1; ; number++) {
        const candidate = numberedName(name, number, file);
        if (!used.has(collisionKey(candidate))) return candidate;
    }
}

// Design-only schema: never read by repository paths or persisted as an active mapping.
function planDirectoryMapping(character, characterDirectories = [], chatDirectories = []) {
    if (!character || typeof character.chaId !== 'string' || !character.chaId) throw new Error('Character ID required');
    const used = new Set(chatDirectories);
    const ids = new Set();
    const chats = (character.chats || []).map(chat => {
        if (typeof chat.id !== 'string' || !chat.id || ids.has(chat.id)) throw new Error('Unique chat ID required');
        ids.add(chat.id);
        const directory = allocateSegment(chat.name, used);
        used.add(directory);
        return { id: chat.id, directory };
    });
    return { schemaVersion: 1, active: false, id: character.chaId, directory: allocateSegment(character.name, new Set(characterDirectories)), chats };
}

module.exports = { sanitizeSegment, allocateSegment, collisionKey, planDirectoryMapping };
