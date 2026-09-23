import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { reclaimDeletedCharacterAssets } = require('./deleted-character-assets.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { createUserDataRepository } = require('./user-data-repository.cjs')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

it('reclaims deleted character assets after saving while preserving shared references and aliased objects', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deleted-assets-'))
    roots.push(dataRoot)
    const store = createFileKv({ dataRoot })
    for (const name of ['unique', 'shared', 'plugin', 'chat', 'alias']) store.kvSet('assets/' + name, Buffer.from(name))
    store.kvSet('cache/alias', Buffer.from('alias'))
    store.kvSet('cache/plugin-storage/example.json', Buffer.from(JSON.stringify({ image: 'assets/plugin' })))
    const repo = createUserDataRepository({ dataRoot })
    const survivor = { chaId: 'stay', name: 'Stay', image: 'assets/shared', chats: [{ id: 'chat2', message: [{ data: 'assets/chat' }] }] }
    repo.importLegacyDatabase({ characters: [
        { chaId: 'gone', image: 'assets/unique', additionalAssets: [['shared', 'assets/shared'], ['plugin', 'assets/plugin'], ['alias', 'assets/alias']], chats: [{ id: 'chat1', message: [{ data: 'assets/chat' }] }] },
        survivor,
    ] })
    const before = store.objectStoreBytes()
    const database = { characters: [survivor] }
    const result = repo.importLegacyDatabase(database, { mode: 'sync' })
    const cleanup = reclaimDeletedCharacterAssets({ candidates: result.deletedAssetCandidates, database, listKeys: store.kvList, read: store.kvGet, remove: store.kvDelManyAndCollect })
    expect(cleanup.count).toBe(2)
    expect(cleanup.reclaimed).toBe(Buffer.byteLength('unique'))
    expect(store.objectStoreBytes()).toBe(before - cleanup.reclaimed)
    expect(store.kvGet('assets/unique')).toBeNull()
    expect(store.kvGet('assets/alias')).toBeNull()
    for (const key of ['assets/shared', 'assets/plugin', 'assets/chat', 'cache/alias']) expect(store.kvGet(key)).not.toBeNull()
    expect(createFileKv({ dataRoot }).kvGet('assets/unique')).toBeNull()
})

it('retains all candidates if plugin references cannot be read or parsed', () => {
    for (const bytes of [null, Buffer.from('invalid json')]) {
        const remove = vi.fn()
        expect(() => reclaimDeletedCharacterAssets({ candidates: ['one'], database: { characters: [] }, listKeys: () => ['cache/plugin-storage/test.json'], read: () => bytes, remove })).toThrow()
        expect(remove).not.toHaveBeenCalled()
    }
})

it('does no scan for ordinary saves and refuses unresolved chats', () => {
    const listKeys = vi.fn(), remove = vi.fn()
    reclaimDeletedCharacterAssets({ candidates: [], listKeys })
    expect(listKeys).not.toHaveBeenCalled()
    expect(() => reclaimDeletedCharacterAssets({ candidates: ['one'], database: { characters: [{ chats: [{ _stub: true }] }] }, listKeys, remove })).toThrow(/Unloaded/)
    expect(remove).not.toHaveBeenCalled()
})
