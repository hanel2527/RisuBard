import { describe, expect, it } from 'vitest'
import { getTagHotkeyWarnings, matchesTagHotkey, normalizeTagAutocompleteSettings } from './settings'

describe('tag autocomplete settings', () => {
    it('supplies old databases with independent default bindings', () => {
        const settings = normalizeTagAutocompleteSettings()
        expect(settings).toMatchObject({ enabled: true, minLength: 1, scope: 'left' })
        expect(settings.hotkeys.accept.map(binding => binding.key)).toEqual(['Enter', 'Tab'])
        settings.hotkeys.accept[0].key = 'F2'
        expect(normalizeTagAutocompleteSettings().hotkeys.accept[0].key).toBe('Enter')
    })

    it('normalizes malformed persisted values and clamps integer length', () => {
        expect(normalizeTagAutocompleteSettings({ enabled: false, minLength: 3.9, scope: 'whole' }))
            .toMatchObject({ enabled: false, minLength: 3, scope: 'whole' })
        for (const [raw, expected] of [[0, 1], [40, 10], [NaN, 1], ['4', 4]]) {
            expect(normalizeTagAutocompleteSettings({ minLength: raw }).minLength).toBe(expected)
        }
        expect(normalizeTagAutocompleteSettings({ hotkeys: { accept: [{ key: 'Control' }] } }).hotkeys.accept)
            .toHaveLength(2)
    })

    it('retains custom bindings and scope through the persisted JSON round trip', () => {
        const value = { enabled: false, minLength: 5, scope: 'whole', hotkeys: { accept: [{ key: 'j', ctrl: true, meta: true }] } }
        const result = normalizeTagAutocompleteSettings(JSON.parse(JSON.stringify(value)))
        expect(result).toMatchObject(value)
        expect(result.hotkeys.accept[0].action).toBe('tagAutocomplete.accept')
        expect(result.hotkeys.previous[0].key).toBe('ArrowUp')
    })

    it('requires exactly the configured modifiers, preserving unrelated combinations', () => {
        const binding = { key: 'j', ctrl: true, action: 'tagAutocomplete.accept' }
        expect(matchesTagHotkey(new KeyboardEvent('keydown', { key: 'J', ctrlKey: true }), binding)).toBe(true)
        for (const modifiers of [{}, { ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }, { ctrlKey: true, metaKey: true }]) {
            expect(matchesTagHotkey(new KeyboardEvent('keydown', { key: 'j', ...modifiers }), binding)).toBe(false)
        }
        expect(matchesTagHotkey(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }), { key: 'Enter', action: '' })).toBe(false)
    })

    it('reports duplicate actions, global shortcuts, and editor shortcuts', () => {
        const settings = normalizeTagAutocompleteSettings({ hotkeys: {
            accept: [{ key: 'z', ctrl: true }], close: [{ key: 'z', ctrl: true }],
        } })
        const warnings = getTagHotkeyWarnings(settings, [{ key: 'z', ctrl: true, action: 'settings' }])
        expect(warnings.some(warning => warning.includes('중복'))).toBe(true)
        expect(warnings.some(warning => warning.includes('settings'))).toBe(true)
        expect(warnings.some(warning => warning.includes('실행 취소'))).toBe(true)
        expect(getTagHotkeyWarnings(normalizeTagAutocompleteSettings(), [])).toEqual([])
    })
})
