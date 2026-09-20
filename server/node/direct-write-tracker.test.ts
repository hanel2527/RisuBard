import { describe, expect, it } from 'vitest'

let createDirectWriteTracker: any
try {
    ({ createDirectWriteTracker } = require('./direct-write-tracker.cjs'))
} catch {
    createDirectWriteTracker = undefined
}

describe('W1 direct-write tracker', () => {
    it('routes root-only prompt mirror edits through the complete preset/settings boundary', () => {
        const tracker = createDirectWriteTracker()
        tracker.observe('root', [{ op: 'replace', path: '/promptTemplate/0/text', value: 'edited' }])
        expect(tracker.take('root')).toBe('botPresetState')
    })
    it('selects bot presets only when every coalesced operation stays in that collection', () => {
        expect(createDirectWriteTracker).toBeTypeOf('function')
        if (!createDirectWriteTracker) return

        const tracker = createDirectWriteTracker()
        tracker.observe('database', [{ op: 'replace', path: '/botPresets/0/name', value: 'Renamed' }])
        tracker.observe('database', [{ op: 'add', path: '/botPresets/1', value: { id: 'preset-2' } }])

        expect(tracker.take('database')).toBe('botPresets')
        expect(tracker.take('database')).toBeNull()
    })

    it('keeps the legacy full-sync lane for entity-mixed, copied, or unrelated operations', () => {
        expect(createDirectWriteTracker).toBeTypeOf('function')
        if (!createDirectWriteTracker) return

        const tracker = createDirectWriteTracker()
        tracker.observe('mixed', [{ op: 'replace', path: '/botPresets/0/name', value: 'Renamed' }])
        tracker.observe('mixed', [{ op: 'replace', path: '/characters/0/name', value: 'Character' }])
        tracker.observe('copied', [{ op: 'copy', from: '/language', path: '/botPresets/0/name' }])
        tracker.observe('other', [{ op: 'replace', path: '/modules/0/name', value: 'Module' }])

        expect(tracker.take('mixed')).toBeNull()
        expect(tracker.take('copied')).toBeNull()
        expect(tracker.take('other')).toBeNull()
    })

    it('selects preset-state direct writes when preset and root-setting patches are coalesced', () => {
        expect(createDirectWriteTracker).toBeTypeOf('function')
        if (!createDirectWriteTracker) return

        const tracker = createDirectWriteTracker()
        tracker.observe('same-request', [
            { op: 'replace', path: '/botPresets/0/name', value: 'Renamed' },
            { op: 'replace', path: '/botPresetsId', value: 1 },
            { op: 'replace', path: '/collectionOrganizers/promptPresets', value: {} },
        ])
        tracker.observe('coalesced', [{ op: 'replace', path: '/botPresetsId', value: 1 }])
        tracker.observe('coalesced', [{ op: 'add', path: '/botPresets/1', value: { id: 'preset-2' } }])

        expect(tracker.take('same-request')).toBe('botPresetState')
        expect(tracker.take('coalesced')).toBe('botPresetState')
    })
})

describe('W2 chat write scope', () => {
    const database = { characters: [{ chaId: 'char-1', chats: [{ id: 'chat-1' }, { id: 'chat-2' }] }] }

    it('coalesces chat bodies, companion metadata and root settings using stable IDs', () => {
        const tracker = createDirectWriteTracker()
        tracker.observeChat('db', 'char-1', 'chat-1')
        tracker.observe('db', [
            { op: 'replace', path: '/characters/0/chats/1/name', value: 'Edited' },
            { op: 'replace', path: '/characters/0/chatPage', value: 1 },
            { op: 'replace', path: '/customCSS', value: 'test' },
        ], database)
        tracker.observeChat('db', 'char-1', 'chat-1')
        expect(tracker.take('db')).toEqual({
            kind: 'chatState', chats: [
                { characterId: 'char-1', chatId: 'chat-1' },
                { characterId: 'char-1', chatId: 'chat-2' },
            ], characterIds: ['char-1'], includeRootSettings: true,
        })
        expect(tracker.take('db')).toBeNull()
    })

    it.each(['/characters', '/characters/0', '/characters/0/chaId', '/characters/0/chats',
        '/characters/0/chats/0', '/characters/0/chats/0/id', '/modules/0/name', '/botPresets/0/name'])
    ('uses full sync for chat updates mixed with %s', (patchPath) => {
        const tracker = createDirectWriteTracker()
        tracker.observeChat('db', 'char-1', 'chat-1')
        tracker.observe('db', [{ op: 'replace', path: patchPath, value: 'changed' }], database)
        expect(tracker.take('db')).toBeNull()
    })

    it('does not let a later preset patch bypass an outstanding chat write', () => {
        const tracker = createDirectWriteTracker()
        tracker.observe('db', [{ op: 'replace', path: '/botPresets/0/name', value: 'test' }])
        tracker.observeChat('db', 'char-1', 'chat-1')
        expect(tracker.take('db')).toBeNull()
    })

    it('retains unsafe state across later chat updates until consumed or cleared', () => {
        const tracker = createDirectWriteTracker()
        tracker.observe('db', [])
        tracker.observeChat('db', 'char-1', 'chat-1')
        expect(tracker.take('db')).toBeNull()
        tracker.observeChat('db', '', 'chat-1')
        expect(tracker.take('db')).toBeNull()
        tracker.observeChat('db', 'char-1', 'chat-1')
        tracker.clear('db')
        expect(tracker.take('db')).toBeNull()
    })
})
