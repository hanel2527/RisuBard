import { afterEach, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { atomicWriteFile } = require('./file-store.cjs')
const createLiveCharacterFiles = fs.existsSync(path.join(import.meta.dirname, 'live-character-files.cjs'))
    ? require('./live-character-files.cjs').createLiveCharacterFiles : undefined
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))
test('does not import historical unregistered A1 copies during startup, but adopts a later edit', () => {
    const { root, repository } = fixture()
    atomicWriteFile(root, 'characters/one/assets/old.png', Buffer.from('old'))
    const store = createFileKv({ dataRoot: root })
    let writes = 0
    const live = createLiveCharacterFiles({ repository, watch: false, settleMs: 0, writeAsset(key: string, bytes: Buffer) { writes++; store.kvSet(key, bytes) } })
    const initial = live.reconcile()
    expect(initial?.database.characters[0].additionalAssets || []).toEqual([])
    expect(writes).toBe(0)
    fs.writeFileSync(path.join(root, 'characters/one/assets/old.png'), 'new')
    live.invalidate()
    expect(live.reconcile().database.characters[0].additionalAssets).toHaveLength(1)
    expect(writes).toBe(1)
})
test('publishes multiple new assets in one KV batch instead of rewriting the manifest per file', () => {
    const { root, repository } = fixture()
    const assets = path.join(root, 'characters/one/assets'); fs.mkdirSync(assets)
    fs.writeFileSync(path.join(assets, 'a.png'), 'a'); fs.writeFileSync(path.join(assets, 'b.png'), 'b')
    const store = createFileKv({ dataRoot: root })
    let batches = 0
    const live = createLiveCharacterFiles({ repository, watch: false, settleMs: 0,
        writeAsset() { throw new Error('per-file manifest rewrite') },
        writeAssets(entries: any[]) { batches++; store.kvSetMany(entries) },
    })
    const result = live.reconcile()
    expect(result.database.characters[0].additionalAssets).toHaveLength(2)
    expect(batches).toBe(1)
})
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-live-files-')); roots.push(root)
    const repository = createUserDataRepository({ dataRoot: root })
    repository.importLegacyDatabase({ botPresets: [], modules: [], personas: [], loreBook: [{ id: 'world', name: 'World', data: [] }],
        characters: [{ chaId: 'one', type: 'character', name: 'One', desc: 'Before', globalLore: [{ key: 'old', content: 'Lore' }], additionalAssets: [], emotionImages: [], chats: [{ id: 'chat', name: 'Chat', message: [{ role: 'user', data: 'Keep me' }] }] }],
    }, { mode: 'sync' })
    const metadata = path.join(root, 'characters/one/metadata.json')
    return { root, repository, metadata }
}
test('adopts plain editor JSON and embedded lore removal without requiring checksum edits, then reopens', () => {
    const { root, repository, metadata } = fixture()
    const value = JSON.parse(fs.readFileSync(metadata, 'utf8'))
    value.desc = 'After'; value.globalLore = []
    fs.writeFileSync(metadata, JSON.stringify(value))
    const result = repository.reconcileCanonicalProjection({ externalEditing: true })
    expect(result.database.characters[0]).toMatchObject({ desc: 'After', globalLore: [], chats: [{ message: [{ data: 'Keep me' }] }] })
    expect(createUserDataRepository({ dataRoot: root }).exportLegacyDatabase().characters[0].desc).toBe('After')
})
test('validates all external input before accepting any file and keeps invalid editor bytes intact', () => {
    const { root, repository, metadata } = fixture()
    const checksum = fs.readFileSync(`${metadata}.sha256`, 'utf8')
    const value = JSON.parse(fs.readFileSync(metadata, 'utf8')); value.desc = 'Valid pending edit'
    fs.writeFileSync(metadata, JSON.stringify(value))
    fs.writeFileSync(path.join(root, 'lorebooks/world.json'), '{')
    expect(() => repository.reconcileCanonicalProjection({ externalEditing: true })).toThrow()
    expect(fs.readFileSync(`${metadata}.sha256`, 'utf8')).toBe(checksum)
    expect(fs.readFileSync(path.join(root, 'lorebooks/world.json'), 'utf8')).toBe('{')
})
test('rejects invalid character field types and stable ID changes', () => {
    const { repository, metadata } = fixture()
    const original = JSON.parse(fs.readFileSync(metadata, 'utf8'))
    for (const edit of [{ desc: 42 }, { globalLore: 'bad' }, { chaId: 'different' }, { chats: [] }]) {
        fs.writeFileSync(metadata, JSON.stringify({ ...original, ...edit }))
        expect(() => repository.reconcileCanonicalProjection({ externalEditing: true })).toThrow()
    }
})
test('accepts global lorebook edits and deletion without deleting character chats', () => {
    const { root, repository } = fixture()
    fs.writeFileSync(path.join(root, 'lorebooks/world.json'), JSON.stringify({ id: 'world', name: 'Edited', data: [] }))
    expect(repository.reconcileCanonicalProjection({ externalEditing: true }).database.loreBook[0].name).toBe('Edited')
    fs.unlinkSync(path.join(root, 'lorebooks/world.json'))
    const result = repository.reconcileCanonicalProjection({ externalEditing: true })
    expect(result.database.loreBook).toEqual([])
    expect(result.database.characters[0].chats[0].message[0].data).toBe('Keep me')
})

function liveFixture() {
    expect(createLiveCharacterFiles).toBeTypeOf('function')
    const base = fixture()
    const store = createFileKv({ dataRoot: base.root })
    const live = createLiveCharacterFiles({ repository: base.repository, writeAsset: store.kvSet, watch: false, settleMs: 0 })
    const assets = path.join(base.root, 'characters/one/assets'); fs.mkdirSync(assets, { recursive: true })
    return { ...base, store, live, assets }
}
test('a dropped asset becomes available, same-size replacement changes its URL, and removal removes the reference', () => {
    const { live, assets, store } = liveFixture()
    fs.writeFileSync(path.join(assets, 'smile.png'), 'first')
    const added = live.reconcile().database.characters[0].additionalAssets[0]
    expect(added[0]).toBe('smile'); expect(store.kvGet(added[1]).toString()).toBe('first')
    fs.writeFileSync(path.join(assets, 'smile.png'), 'other'); live.invalidate()
    const replaced = live.reconcile().database.characters[0].additionalAssets[0]
    expect(replaced[1]).not.toBe(added[1]); expect(store.kvGet(replaced[1]).toString()).toBe('other')
    expect(store.kvGet(added[1]).toString()).toBe('first')
    fs.unlinkSync(path.join(assets, 'smile.png')); live.invalidate()
    expect(live.reconcile().database.characters[0].additionalAssets).toEqual([])
})
test('tracks assets across restart and ignores editor temporary files and checksum sidecars', () => {
    const { root, live, assets, store } = liveFixture()
    fs.writeFileSync(path.join(assets, 'smile.png'), 'first')
    fs.writeFileSync(path.join(assets, '.smile.png'), 'temp')
    fs.writeFileSync(path.join(assets, 'smile.png.bak'), 'backup')
    fs.writeFileSync(path.join(assets, 'smile.png.sha256'), 'checksum')
    expect(live.reconcile().database.characters[0].additionalAssets).toHaveLength(1)
    fs.unlinkSync(path.join(assets, 'smile.png'))
    const restarted = createLiveCharacterFiles({ repository: createUserDataRepository({ dataRoot: root }), writeAsset: store.kvSet, watch: false, settleMs: 0 })
    expect(restarted.reconcile().database.characters[0].additionalAssets).toEqual([])
})
test('retains malformed JSON and retries it after the editor finishes saving', () => {
    const { live, metadata, assets, store, repository } = liveFixture()
    const before = fs.readFileSync(metadata, 'utf8')
    fs.writeFileSync(metadata, '{')
    fs.writeFileSync(path.join(assets, 'new.png'), 'image')
    expect(() => live.reconcile()).toThrow()
    expect(fs.readFileSync(metadata, 'utf8')).toBe('{')
    fs.writeFileSync(metadata, before)
    expect(live.reconcile().database.characters[0].additionalAssets).toHaveLength(1)
    expect(repository.loadChat('one', 'chat').message[0].data).toBe('Keep me')
})
test('external adoption preserves acknowledged but not yet flushed chats and disjoint metadata edits', () => {
    const merge = require('./live-character-files.cjs').mergePendingLiveDatabase
    expect(merge).toBeTypeOf('function')
    const baseline = { characters: [{ chaId: 'one', desc: 'Old', name: 'One' }], loreBook: [] }
    const pending = { language: 'ko', characters: [{ chaId: 'one', desc: 'Old', name: 'App edit', chats: [{ id: 'chat', message: ['Newest'] }] }], loreBook: [] }
    const external = { language: 'en', characters: [{ chaId: 'one', desc: 'File edit', name: 'One', chats: [{ id: 'chat', message: ['Old'] }] }], loreBook: [] }
    expect(merge(pending, baseline, external)).toEqual({ language: 'ko', characters: [{ chaId: 'one', desc: 'File edit', name: 'App edit', chats: [{ id: 'chat', message: ['Newest'] }] }], loreBook: [] })
})
test('deleting one of two equal-content files does not remove the other asset', () => {
    const { live, assets } = liveFixture()
    fs.writeFileSync(path.join(assets, 'one.png'), 'same')
    fs.writeFileSync(path.join(assets, 'two.png'), 'same')
    expect(live.reconcile().database.characters[0].additionalAssets).toHaveLength(2)
    fs.unlinkSync(path.join(assets, 'one.png')); live.invalidate()
    const remaining = live.reconcile().database.characters[0].additionalAssets
    expect(remaining).toHaveLength(1); expect(remaining[0][0]).toBe('two')
})
test('keeps registered extensionless replicas and imports ordinary text assets', () => {
    const { root, repository } = fixture()
    const store = createFileKv({ dataRoot: root })
    store.kvSet('assets/old', Buffer.from('old'))
    const db = repository.exportLegacyDatabase(); db.characters[0].image = 'assets/old'
    repository.importLegacyDatabase(db, { mode: 'sync' })
    store.characterAssets.migrate(db, 'one', store.kvGet)
    const live = createLiveCharacterFiles({ repository, writeAsset: store.kvSet, watch: false, settleMs: 0 })
    fs.writeFileSync(path.join(root, 'characters/one/assets/note.txt'), 'hello')
    const result = live.reconcile().database.characters[0]
    expect(result.image).toBe('assets/old')
    expect(result.additionalAssets[0][0]).toBe('note')
})
test('does not overwrite an editor save made while an asset is being imported', () => {
    const { root, repository, metadata } = fixture()
    const assets = path.join(root, 'characters/one/assets'); fs.mkdirSync(assets)
    fs.writeFileSync(path.join(assets, 'one.png'), 'image')
    const store = createFileKv({ dataRoot: root })
    const live = createLiveCharacterFiles({ repository, watch: false, settleMs: 0, writeAsset(key: string, bytes: Buffer) {
        store.kvSet(key, bytes)
        const value = JSON.parse(fs.readFileSync(metadata, 'utf8')); value.desc = 'New editor save'
        fs.writeFileSync(metadata, JSON.stringify(value))
    } })
    expect(() => live.reconcile()).toThrow()
    expect(JSON.parse(fs.readFileSync(metadata, 'utf8')).desc).toBe('New editor save')
})
test('starts with validated character and lore edits made while the server was stopped', () => {
    const { root, metadata } = fixture()
    const value = JSON.parse(fs.readFileSync(metadata, 'utf8')); value.desc = 'Offline edit'
    fs.writeFileSync(metadata, JSON.stringify(value))
    fs.writeFileSync(path.join(root, 'lorebooks/world.json'), JSON.stringify({ id: 'world', name: 'Offline lore', data: [] }))
    const restarted = createUserDataRepository({ dataRoot: root, liveExternalEditing: true })
    expect(restarted.exportLegacyDatabase().characters[0].desc).toBe('Offline edit')
    expect(restarted.exportLegacyDatabase().loreBook[0].name).toBe('Offline lore')
})
test('startup with incomplete editor JSON can report the error and adopt the repaired file', () => {
    const { root, metadata } = fixture()
    const original = fs.readFileSync(metadata)
    fs.writeFileSync(metadata, '{')
    const repository = createUserDataRepository({ dataRoot: root, liveExternalEditing: true })
    const store = createFileKv({ dataRoot: root })
    const live = createLiveCharacterFiles({ repository, writeAsset: store.kvSet, watch: false, settleMs: 0 })
    expect(() => live.reconcile()).toThrow()
    expect(fs.readFileSync(metadata, 'utf8')).toBe('{')
    fs.writeFileSync(metadata, original)
    expect(live.reconcile().database.characters[0].desc).toBe('Before')
})
test('replacing an A1 replica preserves the original KV bytes used by other characters and exports', () => {
    const { root, repository } = fixture()
    const store = createFileKv({ dataRoot: root })
    store.kvSet('assets/portrait.png', Buffer.from('first'))
    const db = repository.exportLegacyDatabase(); db.characters[0].image = 'assets/portrait.png'
    repository.importLegacyDatabase(db, { mode: 'sync' })
    store.characterAssets.migrate(db, 'one', store.kvGet)
    const live = createLiveCharacterFiles({ repository, writeAsset: store.kvSet, reloadAssets: store.characterAssets.reload, watch: false, settleMs: 0 })
    live.reconcile()
    const index = JSON.parse(fs.readFileSync(path.join(root, 'index/character-asset-replicas.json'), 'utf8'))
    fs.writeFileSync(path.join(root, 'characters/one/assets', index.characters.one.entries[0].filename), 'other')
    live.invalidate()
    const changed = live.reconcile().database.characters[0]
    expect(changed.image).not.toBe('assets/portrait.png')
    expect(store.kvGet(changed.image).toString()).toBe('other')
    expect(store.kvGet('assets/portrait.png').toString()).toBe('first')
    expect(createFileKv({ dataRoot: root }).kvGet('assets/portrait.png').toString()).toBe('first')
})
