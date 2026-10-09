import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const { createFileKv } = require('./file-kv.cjs')
const { createBardWikiVectorStore, compactVector, isBardWikiVectorKey } = require('./bardwiki-vector-store.cjs')

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const key = (index: number) => `cache/bardwiki-vector/${index.toString(16).padStart(64, '0')}.json`

async function setup() {
    const root = await fs.mkdtemp(join(tmpdir(), 'bardwiki-vector-store-'))
    roots.push(root)
    const kv = createFileKv({ dataRoot: root })
    const deletions: number[] = []
    const store = createBardWikiVectorStore({
        dataRoot: root, kvGet: kv.kvGet, kvList: kv.kvList, kvSize: kv.kvSize,
        kvDelManyAndCollect: (keys: string[]) => {
            deletions.push(keys.length)
            return kv.kvDelManyAndCollect(keys)
        },
        queueStorageOperation: async (operation: () => Promise<unknown>) => operation(),
    })
    return { root, kv, store, deletions }
}

describe('BardWiki vector store', () => {
    test('accepts only hashed vector cache keys', () => {
        expect(isBardWikiVectorKey(key(1))).toBe(true)
        expect(isBardWikiVectorKey('cache/bardwiki-vector/../../database.bin')).toBe(false)
        expect(isBardWikiVectorKey('cache/plugin-storage/x.json')).toBe(false)
    })

    test('writes vectors to its folder without touching the KV manifest', async () => {
        const { root, kv, store } = await setup()
        const manifest = join(root, 'kv', 'manifest.json')
        const before = await fs.readFile(manifest, 'utf8').catch(() => '')
        const value = compactVector(Buffer.from('[0.5,-0.25]'))
        await store.writeMany([{ key: key(1), value }])
        expect(await store.read(key(1))).toEqual(value)
        expect(kv.kvList('cache/bardwiki-vector/')).toEqual([])
        expect(await fs.readFile(manifest, 'utf8').catch(() => '')).toBe(before)
        expect(await store.read(key(2))).toBeNull()
    })

    test('moves KV vectors out in batches, compacting JSON and reclaiming objects', async () => {
        const { root, kv, store, deletions } = await setup()
        kv.kvSetMany(Array.from({ length: 300 }, (_, index) => ({
            key: key(index), value: Buffer.from(JSON.stringify([index, 1.5])),
        })))
        kv.kvSet('assets/keep.png', Buffer.from('asset'))
        // Before the move the KV copy is still served.
        expect((await store.read(key(7)))?.toString()).toBe('[7,1.5]')

        expect(await store.migrateFromKv()).toBe(300)
        expect(kv.kvList('cache/bardwiki-vector/')).toEqual([])
        expect(kv.kvGet('assets/keep.png')?.toString()).toBe('asset')
        const moved = await store.read(key(7))
        expect(moved?.subarray(0, 4).toString('latin1')).toBe('RBV1')
        expect(moved?.readFloatLE(4)).toBe(7)
        expect(moved?.readFloatLE(8)).toBe(1.5)
        const objects = await fs.readdir(join(root, 'kv', 'objects'))
        expect(objects).toHaveLength(1)
        // 300 keys span two write batches but rewrite the manifest only once.
        expect(deletions).toEqual([300])
        expect(await store.migrateFromKv()).toBe(0)
    })

    test('keeps an existing folder copy when resuming a move', async () => {
        const { kv, store } = await setup()
        const newer = compactVector(Buffer.from('[9]'))
        await store.writeMany([{ key: key(1), value: newer }])
        kv.kvSetMany([1, 2].map((index) => ({ key: key(index), value: Buffer.from(`[${index}]`) })))

        expect(await store.migrateFromKv()).toBe(1)
        expect(await store.read(key(1))).toEqual(newer)
        expect(kv.kvList('cache/bardwiki-vector/')).toEqual([])
    })

    test('reports and clears vectors in the folder and the KV', async () => {
        const { root, kv, store } = await setup()
        const value = compactVector(Buffer.from('[0.5,-0.25]'))
        await store.writeMany([{ key: key(1), value }, { key: key(2), value }])
        kv.kvSetMany([2, 3].map((index) => ({ key: key(index), value: Buffer.from('[1,2,3]') })))
        kv.kvSet('assets/keep.png', Buffer.from('asset'))

        // key(2) exists in both places and counts once.
        expect(await store.usage()).toEqual({ count: 3, bytes: value.length * 2 + 7 })
        expect(await store.clear()).toEqual({ count: 3, bytes: value.length * 2 + 7 })
        expect(await store.usage()).toEqual({ count: 0, bytes: 0 })
        expect(await store.read(key(1))).toBeNull()
        expect(kv.kvGet('assets/keep.png')?.toString()).toBe('asset')
        expect((await fs.readdir(root)).filter((name) => name.startsWith('bardwiki-vectors'))).toEqual([])

        await store.writeMany([{ key: key(4), value }])
        expect(await store.read(key(4))).toEqual(value)
    })
})
