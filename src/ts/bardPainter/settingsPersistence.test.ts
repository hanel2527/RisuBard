// @vitest-environment node
import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createPainterChatData, createPainterSettings, painterGenerationSettings } from './types'

const require = createRequire(import.meta.url)
const { createUserDataRepository } = require('../../../server/node/user-data-repository.cjs')

it('retains global, bot-pinned and chat generation settings through a canonical repository restart', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-painter-settings-'))
    try {
        const global = painterGenerationSettings(createPainterSettings())
        const pinned = { ...global, width: 1024, height: 1024 }
        const local = createPainterChatData()
        local.settingsScope = 'chat'
        local.settings.width = 1216
        local.settings.perspective = 'first-person'
        local.imagePreset = { promptPresetId: 'prompt', name: 'Image options', values: { toggle_detail: '1' } }
        const database = {
            characters: [{ chaId: 'painter-settings-bot', type: 'character', name: 'Painter test',
                bardPainter: { identities: [
                    { id: 'private', name: 'Private', aliases: ['personal alias'], appearance: 'private appearance' },
                    { id: 'attached', name: 'Attached', aliases: [], appearance: 'public appearance', attachToCard: true },
                ], outfits: [{ id: 'private-outfit', subjectId: 'private', name: 'Private outfit', clothing: 'test clothes', state: '' }], settings: pinned },
                chats: [{ id: 'painter-settings-chat', message: [], bardPainter: local }] }],
            botPresets: [], modules: [], personas: [], loreBook: [], bardPainterSettings: global,
            bardPainterDefaultStyleId: 'favorite-style',
        }
        createUserDataRepository({ dataRoot }).importLegacyDatabase(database, { mode: 'sync' })
        const loaded = createUserDataRepository({ dataRoot }).exportLegacyDatabase()
        expect(loaded.bardPainterSettings).toEqual(global)
        expect(loaded.bardPainterDefaultStyleId).toBe('favorite-style')
        expect(loaded.characters[0].bardPainter.settings).toEqual(pinned)
        expect(loaded.characters[0].bardPainter).toEqual(database.characters[0].bardPainter)
        expect(loaded.characters[0].chats[0].bardPainter).toEqual(local)
    } finally {
        if (path.dirname(path.resolve(dataRoot)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test data root')
        fs.rmSync(dataRoot, { recursive: true, force: true })
    }
})
