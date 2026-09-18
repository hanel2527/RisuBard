import { describe, expect, it } from 'vitest'

let createDirectWriteTracker: any
try {
    ({ createDirectWriteTracker } = require('./direct-write-tracker.cjs'))
} catch {
    createDirectWriteTracker = undefined
}

describe('W1 direct-write tracker', () => {
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
