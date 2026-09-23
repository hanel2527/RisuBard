import { afterEach, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { createFileKv } = require('./file-kv.cjs')
const { atomicWriteJson, atomicWriteFile } = require('./file-store.cjs')
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
    const object = JSON.parse(fs.readFileSync(path.join(root, 'index', 'character-asset-replicas.json'), 'utf8')).characters.one.entries[0].filename
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
it('keeps KV-compatible bytes after metadata removal and falls back with a corrupt replica index', () => {
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
it('preserves friendly labels and extensions, numbers case-insensitive filename collisions and reuses verified names', () => {
    const { root, store, db } = fixture()
    store.kvSet('assets/first.png', Buffer.from('first'))
    store.kvSet('assets/second.png', Buffer.from('second'))
    db.characters[0].additionalAssets = [['Expression', 'assets/first.png', 'png'], ['expression', 'assets/second.png', 'png']]
    const beforeMetadata = fs.readFileSync(path.join(root, 'characters', 'one', 'metadata.json'))
    store.characterAssets.migrate(db, 'one', store.kvGet)
    const index = path.join(root, 'index', 'character-asset-replicas.json')
    const entries = JSON.parse(fs.readFileSync(index, 'utf8')).characters.one.entries
    expect(entries.map(entry => entry.filename)).toEqual(['Expression.png', 'expression (2).png', 'portrait.png'])
    store.characterAssets.migrate(db, 'one', store.kvGet)
    expect(JSON.parse(fs.readFileSync(index, 'utf8')).characters.one.entries).toEqual(entries)
    expect(fs.readFileSync(path.join(root, 'characters', 'one', 'metadata.json'))).toEqual(beforeMetadata)
    expect(fs.readdirSync(path.join(root, 'characters'))).toEqual(['one'])
    expect(createFileKv({ dataRoot: root }).kvGet('assets/second.png').toString()).toBe('second')
})
it('reads old hash-only replica entries and retains them when migrating to friendly filenames', () => {
    const { root, store, db } = fixture()
    const bytes = store.kvGet('assets/portrait.png')
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    atomicWriteFile(root, `characters/one/assets/${hash}`, bytes)
    atomicWriteJson(root, 'index/character-asset-replicas.json', { schemaVersion: 1, characters: { one: { enabled: true, copied: 1, skipped: 0, failed: 0, entries: [{ key: 'assets/portrait.png', hash, size: bytes.length }] } } })
    const reopened = createFileKv({ dataRoot: root })
    expect(reopened.kvGet('assets/portrait.png')).toEqual(bytes)
    expect(reopened.characterAssets.diagnostics().reads).toBe(1)
    reopened.characterAssets.migrate(db, 'one', reopened.kvGet)
    expect(fs.readFileSync(path.join(root, 'characters', 'one', 'assets', 'portrait.png'))).toEqual(bytes)
    expect(fs.readFileSync(path.join(root, 'characters', 'one', 'assets', hash))).toEqual(bytes)
})
it('retains published filenames through interrupted rename and retries without overwriting old copies', () => {
    const { root, store, db } = fixture()
    db.characters[0].additionalAssets = [['Portrait', 'assets/portrait.png', 'png']]
    store.characterAssets.migrate(db, 'one', store.kvGet)
    const index = path.join(root, 'index', 'character-asset-replicas.json')
    const before = fs.readFileSync(index)
    db.characters[0].additionalAssets[0][0] = 'New portrait'
    const rename = fs.renameSync
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(to) === index) throw new Error('Simulated publication interruption')
        return rename(from, to)
    })
    try { expect(() => store.characterAssets.migrate(db, 'one', store.kvGet)).toThrow() }
    finally { spy.mockRestore() }
    expect(fs.readFileSync(index)).toEqual(before)
    expect(createFileKv({ dataRoot: root }).kvGet('assets/portrait.png').toString()).toBe('portrait')
    store.characterAssets.migrate(db, 'one', store.kvGet)
    expect(fs.readFileSync(path.join(root, 'characters', 'one', 'assets', 'Portrait.png')).toString()).toBe('portrait')
    expect(JSON.parse(fs.readFileSync(index, 'utf8')).characters.one.entries[0].filename).toBe('New portrait (2).png')
})
it('reads a current replica with one read and no hash, stat, lstat or metadata existence lookup', () => {
    const { store, db } = fixture()
    store.characterAssets.migrate(db, 'one', store.kvGet)
    const read = vi.spyOn(fs, 'readFileSync')
    const stat = vi.spyOn(fs, 'statSync')
    const lstat = vi.spyOn(fs, 'lstatSync')
    const exists = vi.spyOn(fs, 'existsSync')
    const digest = vi.spyOn(crypto, 'createHash')
    try {
        expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
        expect(read).toHaveBeenCalledTimes(1)
        expect(stat).not.toHaveBeenCalled()
        expect(lstat).not.toHaveBeenCalled()
        expect(exists).not.toHaveBeenCalled()
        expect(digest).not.toHaveBeenCalled()
    } finally { vi.restoreAllMocks() }
})
it('detects same-size external changes only on explicit revalidation and repairs from original KV', () => {
    const { root, store, db } = fixture()
    store.characterAssets.migrate(db, 'one', store.kvGet)
    const index = path.join(root, 'index', 'character-asset-replicas.json')
    const old = JSON.parse(fs.readFileSync(index, 'utf8')).characters.one.entries[0]
    fs.writeFileSync(path.join(root, 'characters', 'one', 'assets', old.filename), 'modified')
    expect(store.kvGet('assets/portrait.png').toString()).toBe('modified')
    const digest = vi.spyOn(crypto, 'createHash')
    try {
        expect(store.characterAssets.migrate(db, 'one', store.kvGet).copied).toBe(1)
        expect(digest).toHaveBeenCalled()
    } finally { digest.mockRestore() }
    expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
    const repaired = JSON.parse(fs.readFileSync(index, 'utf8')).characters.one.entries[0]
    expect(repaired.hash).toBe(old.hash)
    expect(repaired.filename).not.toBe(old.filename)
})

it('refreshes existing replica routes once after mapping publication and preserves the one-read hot path', () => {
    const { root, store, db } = fixture()
    const { createUserDataRepository } = require('./user-data-repository.cjs')
    // The lightweight A1 fixture metadata has no checksum until normal repository import.
    atomicWriteJson(root, 'characters/one/metadata.json', { chaId: 'one' })
    const repo = createUserDataRepository({ dataRoot: root, allowDirectoryMapping: true })
    repo.importLegacyDatabase(db)
    store.characterAssets.migrate(db, 'one', store.kvGet)
    const mapped = repo.publishCharacterDirectoryMapping('one')
    fs.writeFileSync(path.join(root, 'characters/one/assets/portrait.png'), 'old copy')
    expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
    const read = vi.spyOn(fs, 'readFileSync')
    const stat = vi.spyOn(fs, 'statSync')
    const lstat = vi.spyOn(fs, 'lstatSync')
    try {
        expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
        expect(read).toHaveBeenCalledTimes(1)
        expect(String(read.mock.calls[0][0])).toContain(mapped.directory)
        expect(stat).not.toHaveBeenCalled()
        expect(lstat).not.toHaveBeenCalled()
    } finally { vi.restoreAllMocks() }
    expect(createFileKv({ dataRoot: root }).kvGet('assets/portrait.png').toString()).toBe('portrait')
    expect(store.characterAssets.migrate(db, 'one', store.kvGet).copied).toBe(1)
})
