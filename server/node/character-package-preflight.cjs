'use strict';

function stringIds(values) {
    return Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.length > 0) : [];
}

function addIds(target, values) {
    for (const value of stringIds(values)) target.add(value);
}

function addCharacterReferences(target, character) {
    addIds(target, character?.modules);
    for (const chat of Array.isArray(character?.chats) ? character.chats : []) addIds(target, chat?.modules);
}

function inspectCharacterPackageOwnership(database, characterId) {
    if (!database || typeof database !== 'object' || typeof characterId !== 'string' || characterId.length === 0) {
        throw new Error('Invalid character package preflight input');
    }
    const characters = (Array.isArray(database.characters) ? database.characters : [])
        .filter(character => character?.chaId === characterId || character?.id === characterId);
    if (characters.length === 0) throw new Error('Character not found for package preflight');
    if (characters.length > 1) throw new Error('duplicate character identity in package preflight');
    const character = characters[0];

    const definedModules = new Set();
    for (const module of Array.isArray(database.modules) ? database.modules : []) {
        if (typeof module?.id !== 'string' || module.id.length === 0) continue;
        if (definedModules.has(module.id)) throw new Error('Duplicate module identity in package preflight');
        definedModules.add(module.id);
    }

    const targetRefs = new Set();
    addCharacterReferences(targetRefs, character);
    const otherRefs = new Set();
    for (const other of Array.isArray(database.characters) ? database.characters : []) {
        if (other === character) continue;
        addCharacterReferences(otherRefs, other);
    }

    const globalRefs = new Set();
    addIds(globalRefs, database.enabledModules);
    addIds(globalRefs, typeof database.moduleIntergration === 'string'
        ? database.moduleIntergration.split(',').map(value => value.trim())
        : []);
    if (database.personaEnabledModules && typeof database.personaEnabledModules === 'object') {
        for (const ids of Object.values(database.personaEnabledModules)) addIds(globalRefs, ids);
    }
    for (const persona of Array.isArray(database.personas) ? database.personas : []) {
        if (typeof persona?.embeddedModule?.id === 'string' && persona.embeddedModule.id) globalRefs.add(persona.embeddedModule.id);
    }

    const sharedModuleIds = [...targetRefs].filter(id => otherRefs.has(id) || globalRefs.has(id));
    const shared = new Set(sharedModuleIds);
    const missingModuleIds = [...targetRefs].filter(id => !definedModules.has(id));
    const missing = new Set(missingModuleIds);
    const moduleCandidates = [...targetRefs].filter(id => !shared.has(id) && !missing.has(id));
    const globalModuleIds = [...globalRefs].filter(id => !shared.has(id));
    const personas = Array.isArray(character.personas) ? character.personas : [];

    return {
        schemaVersion: 1,
        characterId,
        wikiChatIds: (Array.isArray(character.chats) ? character.chats : [])
            .map(chat => chat?.id).filter(id => typeof id === 'string' && id.length > 0),
        embeddedCharacterPersonaIds: personas
            .map(persona => persona?.id).filter(id => typeof id === 'string' && id.length > 0),
        embeddedPersonaModuleIds: personas
            .map(persona => persona?.embeddedModule?.id).filter(id => typeof id === 'string' && id.length > 0),
        moduleCandidates,
        sharedModuleIds,
        globalModuleIds,
        missingModuleIds,
        // Legacy plugins can request the full database and may retain module IDs outside typed fields.
        requiresPluginCompatibility: true,
    };
}

module.exports = { inspectCharacterPackageOwnership };
