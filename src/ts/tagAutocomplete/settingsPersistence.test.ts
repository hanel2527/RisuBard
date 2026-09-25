// @vitest-environment node
import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { normalizeTagAutocompleteSettings } from './settings'

const require = createRequire(import.meta.url)
const { createUserDataRepository } = require('../../../server/node/user-data-repository.cjs')

it('preserves autocomplete controls and custom bindings across canonical repository restarts', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-tag-settings-'))
    try {
        const settings = normalizeTagAutocompleteSettings({
            enabled: false, minLength: 6, scope: 'whole',
            hotkeys: { accept: [{ key: 'j', ctrl: true, meta: true }, { key: 'F2' }] },
        })
        const database = {
            characters: [], botPresets: [], modules: [], personas: [], loreBook: [],
            tagAutocomplete: settings,
        }
        createUserDataRepository({ dataRoot }).importLegacyDatabase(database, { mode: 'sync' })
        const reopened = createUserDataRepository({ dataRoot })
        const loaded = reopened.exportLegacyDatabase()
        expect(loaded.tagAutocomplete).toEqual(settings)
        expect(normalizeTagAutocompleteSettings(loaded.tagAutocomplete)).toMatchObject({
            enabled: false, minLength: 6, scope: 'whole',
            hotkeys: { accept: [{ key: 'j', ctrl: true, meta: true }, { key: 'F2' }] },
        })
        loaded.tagAutocomplete = normalizeTagAutocompleteSettings()
        reopened.importLegacyDatabase(loaded, { mode: 'sync' })
        const reset = createUserDataRepository({ dataRoot }).exportLegacyDatabase().tagAutocomplete
        expect(reset.minLength).toBe(1)
        expect(reset.hotkeys.accept.map((binding: { key: string }) => binding.key)).toEqual(['Enter', 'Tab'])
    } finally {
        if (path.dirname(path.resolve(dataRoot)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test data root')
        fs.rmSync(dataRoot, { recursive: true, force: true })
    }
})
