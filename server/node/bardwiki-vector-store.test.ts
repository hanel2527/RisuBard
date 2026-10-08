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
    const store = createBardWikiVectorStore({
        dataRoot: root, kvGet: kv.kvGet, kvList: kv.kvList,
        kvDelManyAndCollect: kv.kvDelManyAndCollect,
        queueStorageOperation: async (operation: () => Promise<unknown>) => operation(),
    })
    return { root, kv, store }
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
        const { root, kv, store } = await setup()
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
        expect(await store.migrateFromKv()).toBe(0)
    })
})
