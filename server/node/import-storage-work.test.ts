import { afterEach, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { atomicWriteJson } = require('./file-store.cjs')
const progress = require('./import-progress.cjs')
const roots: string[] = []
const workerModule = path.resolve(import.meta.dirname, 'import-storage-work.cjs')
const repositoryOptions = (dataRoot: string) => ({ dataRoot, allowDirectoryMapping: true,
    maintainDirectoryNames: true, liveExternalEditing: true, newCharacterPackages: true })

function fixture() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-import-worker-'))
    roots.push(dataRoot)
    const database = { language: 'en', botPresets: [], modules: [], personas: [], loreBook: [], characters: [{
        chaId: 'owner', type: 'character', name: 'Owner', desc: 'Original', image: 'assets/shared.png',
        chats: [{ id: 'existing-chat', name: 'Existing', message: [{ role: 'user', chatId: 'existing-message', data: 'Keep this message' }] }],
    }] }
    const repository = createUserDataRepository(repositoryOptions(dataRoot))
    repository.importLegacyDatabase(database, { mode: 'sync' })
    const store = createFileKv({ dataRoot })
    store.kvSetMany([
        { key: 'assets/shared.png', value: Buffer.from('shared image') },
        { key: 'assets/pre-existing-orphan.png', value: Buffer.from('pre-existing orphan') },
    ])
    return { dataRoot, repository, database, store }
}

function run(method: string, input: unknown) {
    return progress.withImportProgress(randomUUID(), () => progress.runImportWork(workerModule, method, input))
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

test('off-thread import publishes readable mapped chats and character asset replicas', async () => {
    const { dataRoot, repository, database, store } = fixture()
    store.kvSet('assets/imported.png', Buffer.from('imported portrait'))
    const imported = { chaId: 'imported', type: 'character', name: 'Imported', desc: 'New character', image: 'assets/imported.png',
        chats: [{ id: 'new-chat', name: 'New chat', message: [{ role: 'char', chatId: 'new-message', data: 'New conversation' }] }] }
    const input = { ...database, characters: [...database.characters, imported] }
    const result = await run('persistProjection', { dataRoot, database: input, expectedRevision: repository.getProjectionRevision() })
    const reopened = createUserDataRepository(repositoryOptions(dataRoot))
    expect(reopened.loadChat('owner', 'existing-chat').message).toEqual(database.characters[0].chats[0].message)
    expect(reopened.loadChat('imported', 'new-chat').message).toEqual(imported.chats[0].message)
    const directory = reopened.characterDirectoryStatus('imported').directory
    expect(fs.readFileSync(path.join(dataRoot, 'characters', directory, 'assets/imported.png')).toString()).toBe('imported portrait')
    expect(result.revision).toBe(reopened.getProjectionRevision())
})

test('worker rejects an intervening canonical edit without overwriting it', async () => {
    const { dataRoot, repository, database } = fixture()
    const expectedRevision = repository.getProjectionRevision()
    const directory = repository.characterDirectoryStatus('owner').directory
    const relative = `characters/${directory}/metadata.json`
    const metadata = JSON.parse(fs.readFileSync(path.join(dataRoot, relative), 'utf8'))
    atomicWriteJson(dataRoot, relative, { ...metadata, desc: 'External edit' })
    await expect(run('persistProjection', { dataRoot, database, expectedRevision }))
        .rejects.toMatchObject({ code: 'CANONICAL_FILES_CHANGED', importStage: 'external-change-check' })
    expect(createUserDataRepository(repositoryOptions(dataRoot)).loadCharacter('owner').desc).toBe('External edit')
})

test('worker rollback reclaims only candidate orphans and clears its durable marker', async () => {
    const { dataRoot, store } = fixture()
    const marker = `cache/import-rollback/${randomUUID()}`
    store.kvSetMany([
        { key: 'assets/import-only.png', value: Buffer.from('import-only image') },
        { key: marker, value: Buffer.from('pending') },
    ])
    const result = await run('rollbackAssets', { dataRoot, marker, keys: ['assets/import-only.png', 'assets/shared.png'] })
    store.reloadManifest()
    expect(store.kvGet('assets/import-only.png')).toBeNull()
    expect(store.kvGet('assets/shared.png')).toEqual(Buffer.from('shared image'))
    expect(store.kvGet('assets/pre-existing-orphan.png')).toEqual(Buffer.from('pre-existing orphan'))
    expect(store.kvGet(marker)).toBeNull()
    expect(result.count).toBe(1)
})
