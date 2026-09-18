import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createUserDataRepository } = require('./user-data-repository.cjs')
let createCanonicalProjectionSync: any
try {
    ({ createCanonicalProjectionSync } = require('./canonical-projection-sync.cjs'))
} catch {
    createCanonicalProjectionSync = undefined
}

const roots: string[] = []

function replaceCanonicalJson(dataRoot: string, relativePath: string, value: unknown) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    const target = path.join(dataRoot, relativePath)
    fs.writeFileSync(target, bytes)
    fs.writeFileSync(`${target}.sha256`, `${crypto.createHash('sha256').update(bytes).digest('hex')}\n`)
}
afterEach(() => {
    roots.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true }))
})

describe('canonical projection sync', () => {
    it('loads externally edited canonical files and advances the accepted revision only after adoption', () => {
        expect(createCanonicalProjectionSync).toBeTypeOf('function')
        if (!createCanonicalProjectionSync) return

        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-projection-sync-'))
        roots.push(dataRoot)
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase({
            language: 'ko',
            botPresets: [{ id: 'preset-1', name: 'Original' }],
            modules: [], personas: [], loreBook: [], characters: [],
        }, { mode: 'merge' })

        let acceptedRevision: string | null = null
        const sync = createCanonicalProjectionSync({
            repository,
            readAcceptedRevision: () => acceptedRevision,
            writeAcceptedRevision: (revision: string) => { acceptedRevision = revision },
        })

        const initial = sync.loadExternalChanges()
        expect(initial?.database.botPresets[0].name).toBe('Original')
        expect(acceptedRevision).toBeNull()
        sync.accept(initial.revision)
        expect(sync.hasExternalChanges).toBeTypeOf('function')
        if (!sync.hasExternalChanges) return
        expect(sync.hasExternalChanges()).toBe(false)
        expect(sync.loadExternalChanges()).toBeNull()

        const presetPath = path.join(dataRoot, 'presets', 'preset-1.json')
        const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'))
        preset.name = 'Externally edited'
        replaceCanonicalJson(dataRoot, 'presets/preset-1.json', preset)

        expect(sync.hasExternalChanges()).toBe(true)
        const changed = sync.loadExternalChanges()
        expect(changed?.database.botPresets[0].name).toBe('Externally edited')
        expect(acceptedRevision).toBe(initial.revision)
        sync.accept(changed.revision)
        expect(acceptedRevision).toBe(changed.revision)
        expect(sync.loadExternalChanges()).toBeNull()
    })

    it('reconciles the sidebar before returning an externally edited compatibility projection', () => {
        expect(createCanonicalProjectionSync).toBeTypeOf('function')
        if (!createCanonicalProjectionSync) return

        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-projection-sync-'))
        roots.push(dataRoot)
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase({
            language: 'ko', botPresets: [], modules: [], personas: [], loreBook: [],
            characters: [{
                chaId: 'char-1', name: 'Original', modification_date: 1_700_000_000,
                globalLore: [{ key: 'old' }], chats: [],
            }],
        }, { mode: 'sync' })

        let acceptedRevision = repository.getProjectionRevision()
        const sync = createCanonicalProjectionSync({
            repository,
            readAcceptedRevision: () => acceptedRevision,
            writeAcceptedRevision: (revision: string) => { acceptedRevision = revision },
        })
        const metadata = repository.loadCharacter('char-1')
        metadata.name = 'External character'
        metadata.modification_date = 1_800_000_000
        metadata.globalLore = [{ key: 'new' }]
        replaceCanonicalJson(dataRoot, 'characters/char-1/metadata.json', metadata)

        const changed = sync.loadExternalChanges()

        expect(changed?.database.characters[0]).toMatchObject({
            name: 'External character',
            globalLore: [{ key: 'new' }],
        })
        expect(repository.loadSidebarIndex().characters[0]).toMatchObject({
            name: 'External character',
            updatedAt: 1_800_000_000_000,
        })
        expect(changed?.database).toStrictEqual(repository.exportLegacyDatabase())
        expect(changed?.revision).toBe(repository.getProjectionRevision())
    })

    it('invalidates a character whose globalLore changed while display summaries stayed the same', () => {
        expect(createCanonicalProjectionSync).toBeTypeOf('function')
        if (!createCanonicalProjectionSync) return

        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-projection-sync-'))
        roots.push(dataRoot)
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase({
            botPresets: [], modules: [], personas: [], loreBook: [],
            characters: [{
                chaId: 'char-1', name: 'Same name', modification_date: 1_800_000_000,
                globalLore: [{ key: 'old' }], chats: [],
            }],
        }, { mode: 'sync' })
        let acceptedRevision = repository.getProjectionRevision()
        const sync = createCanonicalProjectionSync({
            repository,
            readAcceptedRevision: () => acceptedRevision,
            writeAcceptedRevision: (revision: string) => { acceptedRevision = revision },
        })
        const metadata = repository.loadCharacter('char-1')
        metadata.globalLore = [{ key: 'new' }]
        metadata.modification_date = 1_800_000_001
        replaceCanonicalJson(dataRoot, 'characters/char-1/metadata.json', metadata)

        const changed = sync.loadExternalChanges()

        expect(changed?.sidebarWritten).toBe(true)
        expect(changed?.database.characters[0].globalLore).toEqual([{ key: 'new' }])
        expect(repository.loadSidebarIndex().characters[0]).toMatchObject({
            name: 'Same name',
            updatedAt: 1_800_000_001_000,
        })
    })
})
