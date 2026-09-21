import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { createFileKv } = require('./file-kv.cjs')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-assets-')); roots.push(root)
    const store = createFileKv({ dataRoot: root })
    store.kvSet('assets/portrait.png', Buffer.from('portrait'))
    store.kvSet('assets/shared.png', Buffer.from('shared'))
    fs.mkdirSync(path.join(root, 'characters', 'one'), { recursive: true })
    fs.writeFileSync(path.join(root, 'characters', 'one', 'metadata.json'), '{}')
    const db = { characters: [{ chaId: 'one', image: 'assets/portrait.png', additionalAssets: [['shared', 'assets/shared.png', 'png']] }, { chaId: 'two', image: 'assets/shared.png' }] }
    return { root, store, db }
}
it('copies only unique explicit character references and retains KV bytes across reopen', () => {
    const { root, store, db } = fixture()
    const before = fs.readFileSync(path.join(root, 'kv', 'manifest.json'))
    expect(store.characterAssets.migrate(db, 'one', store.kvGet).copied).toBe(1)
    expect(store.characterAssets.status('one').skipped).toBe(1)
    expect(fs.readFileSync(path.join(root, 'kv', 'manifest.json'))).toEqual(before)
    expect(store.characterAssets.migrate(db, 'one', store.kvGet).copied).toBe(1)
    const reopened = createFileKv({ dataRoot: root })
    expect(reopened.kvGet('assets/portrait.png').toString()).toBe('portrait')
    expect(reopened.characterAssets.diagnostics().reads).toBe(1)
})
it('falls back on corrupt or missing replicas, and honors replacement and deletion of KV keys', () => {
    const { root, store, db } = fixture()
    store.characterAssets.migrate(db, 'one', store.kvGet)
    const dir = path.join(root, 'characters', 'one', 'assets')
    const object = fs.readdirSync(dir).find(name => /^[a-f0-9]{64}$/.test(name))!
    fs.writeFileSync(path.join(dir, object), 'broken')
    expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
    expect(store.characterAssets.diagnostics().fallbacks).toBe(1)
    store.kvSet('assets/portrait.png', Buffer.from('replacement'))
    expect(store.kvGet('assets/portrait.png').toString()).toBe('replacement')
    store.kvDel('assets/portrait.png')
    expect(store.kvGet('assets/portrait.png')).toBeNull()
})
it('fails closed for ambiguous IDs and excludes global or embedded shared references', () => {
    const { store, db } = fixture()
    expect(() => store.characterAssets.migrate(db, '../one', store.kvGet)).toThrow()
    expect(() => store.characterAssets.migrate({ characters: [db.characters[0], db.characters[0]] }, 'one', store.kvGet)).toThrow()
    expect(store.characterAssets.migrate({ ...db, css: 'url(assets/portrait.png)' }, 'one', store.kvGet).copied).toBe(0)
})
it('records missing sources, retries, and disables reads without deleting either copy', () => {
    const { store, db } = fixture()
    store.kvDel('assets/portrait.png')
    expect(store.characterAssets.migrate(db, 'one', store.kvGet).failed).toBe(1)
    store.kvSet('assets/portrait.png', Buffer.from('portrait'))
    expect(store.characterAssets.migrate(db, 'one', store.kvGet).failed).toBe(0)
    store.characterAssets.disable('one')
    expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
    expect(store.characterAssets.status('one').enabled).toBe(false)
})
it('keeps legacy export bytes identical and falls back after character deletion or corrupt replica index', () => {
    const { root, store, db } = fixture()
    const before = store.kvList().map(key => [key, store.kvGet(key)])
    store.characterAssets.migrate(db, 'one', store.kvGet)
    expect(store.kvList().map(key => [key, store.kvGet(key)])).toEqual(before)
    fs.unlinkSync(path.join(root, 'characters', 'one', 'metadata.json'))
    expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
    fs.writeFileSync(path.join(root, 'index', 'character-asset-replicas.json'), 'broken')
    const reopened = createFileKv({ dataRoot: root })
    expect(reopened.kvGet('assets/portrait.png').toString()).toBe('portrait')
})
it('status changes no files and disabling one character preserves the other character replica', () => {
    const { root, store, db } = fixture()
    db.characters[0].additionalAssets = []
    fs.mkdirSync(path.join(root, 'characters', 'two'), { recursive: true })
    fs.writeFileSync(path.join(root, 'characters', 'two', 'metadata.json'), '{}')
    store.characterAssets.migrate(db, 'one', store.kvGet)
    store.characterAssets.migrate(db, 'two', store.kvGet)
    const index = path.join(root, 'index', 'character-asset-replicas.json')
    const before = fs.readFileSync(index)
    const other = store.characterAssets.status('two')
    store.characterAssets.status('one')
    expect(fs.readFileSync(index)).toEqual(before)
    store.characterAssets.disable('one')
    expect(store.characterAssets.status('two')).toEqual(other)
    const reads = store.characterAssets.diagnostics().reads
    expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
    expect(store.characterAssets.diagnostics().reads).toBe(reads)
    expect(store.kvGet('assets/shared.png').toString()).toBe('shared')
    expect(store.characterAssets.diagnostics().reads).toBe(reads + 1)
})
