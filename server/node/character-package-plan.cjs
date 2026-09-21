'use strict';

const { sanitizeSegment } = require('./friendly-paths.cjs');
const KINDS = { wiki: 'wiki', module: 'modules', persona: 'personas' };
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);

// Candidate schema only. No filesystem access, ownership inference, or runtime activation.
function planCharacterPackage(characterId, directory, resources) {
    if (!validId(characterId) || typeof directory !== 'string' || sanitizeSegment(directory) !== directory) throw new Error('Invalid package identity');
    const root = `characters/${directory}`;
    const owned = [];
    const globalRefs = [];
    const externalCharacterRefs = [];
    const seen = new Set();
    for (const resource of resources) {
        if (!resource || !Object.hasOwn(KINDS, resource.kind) || !validId(resource.id)) throw new Error('Invalid resource reference');
        const key = `${resource.kind}:${resource.id}`;
        if (seen.has(key)) throw new Error('Duplicate resource reference');
        seen.add(key);
        if (resource.ownership === 'character-exclusive' && validId(resource.ownerCharacterId) && resource.ownerCharacterId !== characterId) {
            externalCharacterRefs.push({ kind: resource.kind, id: resource.id, ownerCharacterId: resource.ownerCharacterId });
            continue;
        }
        if (resource.ownership !== 'character-exclusive' || resource.ownerCharacterId !== characterId) {
            globalRefs.push({ kind: resource.kind, id: resource.id });
            continue;
        }
        if (resource.kind === 'wiki' && !validId(resource.chatId)) throw new Error('Wiki chat scope required');
        owned.push({
            kind: resource.kind,
            id: resource.id,
            ownerCharacterId: characterId,
            root: `${root}/${KINDS[resource.kind]}${resource.kind === 'wiki' ? `/${resource.chatId}` : ''}`,
            ...(resource.kind === 'wiki' ? { chatId: resource.chatId } : {}),
        });
    }
    return { schemaVersion: 1, active: false, characterId, directory, manifest: `${root}/package.json`, owned, globalRefs, externalCharacterRefs };
}

module.exports = { planCharacterPackage };
