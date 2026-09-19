import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let writeCanonicalProjection: any
try {
    ({ writeCanonicalProjection } = require('./canonical-projection-writer.cjs'))
} catch {
    writeCanonicalProjection = undefined
}

describe('W1 canonical projection writer', () => {
    it('uses the direct collection lane for bot presets', () => {
        expect(writeCanonicalProjection).toBeTypeOf('function')
        if (!writeCanonicalProjection) return

        const direct = vi.fn(() => ({ files: 2 }))
        const full = vi.fn()
        const result = writeCanonicalProjection({
            repository: { syncLegacyCollection: direct, importLegacyDatabase: full },
            database: { botPresets: [{ id: 'preset-1' }] },
            directCollection: 'botPresets',
        })

        expect(direct).toHaveBeenCalledWith('botPresets', [{ id: 'preset-1' }])
        expect(full).not.toHaveBeenCalled()
        expect(result).toMatchObject({ strategy: 'bot-presets-direct', fallbackUsed: false, result: { files: 2 } })
    })

    it('falls back to the existing full projection when the direct lane fails', () => {
        expect(writeCanonicalProjection).toBeTypeOf('function')
        if (!writeCanonicalProjection) return

        const directError: any = new Error('direct failed')
        directError.code = 'EIO'
        const fullResult = { files: 9 }
        const result = writeCanonicalProjection({
            repository: {
                syncLegacyCollection: () => { throw directError },
                importLegacyDatabase: vi.fn(() => fullResult),
            },
            database: { botPresets: [] },
            directCollection: 'botPresets',
        })

        expect(result).toEqual({
            strategy: 'bot-presets-direct',
            fallbackUsed: true,
            fallbackCode: 'EIO',
            result: fullResult,
        })
    })

    it('writes preset companion settings without syncing unrelated entities', () => {
        expect(writeCanonicalProjection).toBeTypeOf('function')
        if (!writeCanonicalProjection) return

        const direct = vi.fn(() => ({ files: 4 }))
        const full = vi.fn()
        const database = { botPresetsId: 1, botPresets: [{ id: 'preset-2' }] }
        const result = writeCanonicalProjection({
            repository: { syncLegacyPresetState: direct, importLegacyDatabase: full },
            database,
            directCollection: 'botPresetState',
        })

        expect(direct).toHaveBeenCalledWith(database)
        expect(full).not.toHaveBeenCalled()
        expect(result).toMatchObject({ strategy: 'bot-presets-direct', fallbackUsed: false, result: { files: 4 } })
    })

    it('is wired into the patch debounce boundary without changing mixed patches', () => {
        const server = fs.readFileSync(path.join(process.cwd(), 'server', 'node', 'server.cjs'), 'utf8')

        expect(server).toContain("require('./direct-write-tracker.cjs')")
        expect(server).toContain("require('./canonical-projection-writer.cjs')")
        expect(server).toContain('directWriteTracker.observe(filePath, patch, snapshot)')
        expect(server).toContain('directCollection: directWriteTracker.take(filePath)')
    })
})

describe('W2 canonical projection writer', () => {
    it('queues external flushes as well as debounce writes', () => {
        const server = fs.readFileSync(path.join(process.cwd(), 'server/node/server.cjs'), 'utf8')
        expect(/function flushPendingDb\(\)\s*\{\s*return queueStorageOperation\(flushPendingDbWithinQueue\)/.test(server)).toBe(true)
    })
    it('resolves a partially published direct journal before fallback and a later save', () => {
        const { createUserDataRepository } = require('./user-data-repository.cjs')
        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-w2-fallback-'))
        try {
            const repository = createUserDataRepository({ dataRoot })
            const database = { botPresets: [], modules: [], personas: [], loreBook: [], characters: [
                { chaId: 'char-1', name: 'before', chats: [{ id: 'chat-1', message: [{ role: 'user', data: 'before' }] }] },
            ] }
            repository.importLegacyDatabase(database, { mode: 'sync' })
            database.characters[0].name = 'first edit'
            database.characters[0].chats[0].message[0].data = 'first edit'
            const original = fs.renameSync
            let failed = false
            const spy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
                if (!failed && String(source).includes('.stage') && String(destination).endsWith('messages.jsonl')) {
                    failed = true
                    throw Object.assign(new Error('injected one-shot disk error'), { code: 'EIO' })
                }
                return original(source, destination)
            })
            try {
                const result = writeCanonicalProjection({ repository, database, directCollection: {
                    kind: 'chatState', chats: [{ characterId: 'char-1', chatId: 'chat-1' }], characterIds: ['char-1'],
                } })
                expect(failed).toBe(true)
                expect(result).toMatchObject({ strategy: 'chat-direct', fallbackUsed: true })
            } finally { spy.mockRestore() }
            database.characters[0].name = 'later edit'
            database.characters[0].chats[0].message[0].data = 'later edit'
            repository.importLegacyDatabase(database, { mode: 'sync' })
            expect(createUserDataRepository({ dataRoot }).exportLegacyDatabase()).toEqual(database)
            expect(fs.readdirSync(path.join(dataRoot, '.journal'))).toEqual([])
        } finally { fs.rmSync(dataRoot, { recursive: true, force: true }) }
    })
    const scope = { kind: 'chatState', chats: [{ characterId: 'char-1', chatId: 'chat-1' }] }
    it('selects the chat lane and falls back with the same full snapshot on failure', () => {
        const database = { characters: [] }
        const direct = vi.fn(() => ({ files: 4 }))
        const full = vi.fn(() => ({ files: 12 }))
        const repository = { syncLegacyChatState: direct, importLegacyDatabase: full }
        expect(writeCanonicalProjection({ repository, database, directCollection: scope }))
            .toMatchObject({ strategy: 'chat-direct', fallbackUsed: false, result: { files: 4 } })
        expect(direct).toHaveBeenCalledWith(database, scope)
        expect(full).not.toHaveBeenCalled()
        direct.mockImplementation(() => { throw Object.assign(new Error('write failed'), { code: 'EIO' }) })
        expect(writeCanonicalProjection({ repository, database, directCollection: scope }))
            .toMatchObject({ strategy: 'chat-direct', fallbackUsed: true, fallbackCode: 'EIO' })
        expect(full).toHaveBeenCalledWith(database, { mode: 'sync' })
    })
})
