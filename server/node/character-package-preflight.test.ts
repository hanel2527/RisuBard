import { expect, it } from 'vitest'
const { inspectCharacterPackageOwnership } = require('./character-package-preflight.cjs')

it('separates target-only module candidates from shared, global and missing references', () => {
    const database = {
        modules: [{ id: 'only' }, { id: 'shared' }, { id: 'global' }, { id: 'persona-global' }],
        enabledModules: ['global'],
        moduleIntergration: 'integration, shared',
        personaEnabledModules: { persona: ['persona-global'] },
        personas: [{ id: 'global-persona', embeddedModule: { id: 'embedded-global' } }],
        characters: [
            {
                chaId: 'target',
                modules: ['only', 'shared', 'missing'],
                personas: [{ id: 'local-persona', embeddedModule: { id: 'embedded-local' } }],
                chats: [{ id: 'chat-a', modules: ['only'] }, { id: 'chat-b', modules: [] }],
            },
            { chaId: 'other', modules: ['shared'], chats: [{ id: 'other-chat', modules: ['other-only'] }] },
        ],
    }

    expect(inspectCharacterPackageOwnership(database, 'target')).toEqual({
        schemaVersion: 1,
        characterId: 'target',
        wikiChatIds: ['chat-a', 'chat-b'],
        embeddedCharacterPersonaIds: ['local-persona'],
        embeddedPersonaModuleIds: ['embedded-local'],
        moduleCandidates: ['only'],
        sharedModuleIds: ['shared'],
        globalModuleIds: ['global', 'integration', 'persona-global', 'embedded-global'],
        missingModuleIds: ['missing'],
        requiresPluginCompatibility: true,
    })
})

it('rejects absent or duplicate character identities', () => {
    expect(() => inspectCharacterPackageOwnership({ characters: [] }, 'target')).toThrow(/not found/)
    expect(() => inspectCharacterPackageOwnership({ characters: [{ chaId: 'target' }, { chaId: 'target' }] }, 'target')).toThrow(/duplicate/)
})
