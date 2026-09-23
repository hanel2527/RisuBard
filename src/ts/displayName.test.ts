import { describe, expect, test } from 'vitest'
import { createUniqueDisplayName, normalizeDisplayName } from './displayName'

describe('display names', () => {
    test('detects equivalent whitespace, case, and unicode names as collisions', () => {
        expect(normalizeDisplayName('  TANYA  ')).toBe(normalizeDisplayName('Tanya'))
        expect(createUniqueDisplayName('Tanya', [' tanya ', 'Tanya (2)', 'TANYA (3)']))
            .toBe('Tanya (4)')
    })

    test('keeps a self rename unchanged while avoiding another matching name', () => {
        expect(createUniqueDisplayName('Tanya', [
            { chaId: 'self', name: 'Tanya' },
            { chaId: 'other', name: 'tanya' },
        ], 'self')).toBe('Tanya (2)')
        expect(createUniqueDisplayName('Tanya', [{ chaId: 'self', name: 'Tanya' }], 'self'))
            .toBe('Tanya')
    })

    test('does not treat entries without an ID as the excluded entry', () => {
        expect(createUniqueDisplayName('Tanya', [{ name: 'Tanya' }])).toBe('Tanya (2)')
    })

    test('preserves a non-colliding display name exactly', () => {
        expect(createUniqueDisplayName('Tanya - imported', ['Tanya'])).toBe('Tanya - imported')
    })
})
