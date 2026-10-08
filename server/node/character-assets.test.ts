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
function mappedFixture() {
    const fixtureValue = fixture()
    const { root, store, db } = fixtureValue
    const { createUserDataRepository } = require('./user-data-repository.cjs')
    atomicWriteJson(root, 'characters/one/metadata.json', { chaId: 'one' })
    const repo = createUserDataRepository({ dataRoot: root, allowDirectoryMapping: true })
    repo.importLegacyDatabase(db)
    const mapped = repo.publishCharacterDirectoryMapping('one')
    return { ...fixtureValue, directory: path.join(root, 'characters', mapped.directory, 'assets') }
}
it('stages new asset copies from immutable source paths instead of retaining all asset buffers', () => {
    const { root, store, db, directory } = mappedFixture()
    const fileStore = require('./file-store.cjs')
    const commit = vi.spyOn(fileStore, 'commitTransaction')
    const modulePath = require.resolve('./character-assets.cjs')
    delete require.cache[modulePath]
    try {
        const { createCharacterAssets } = require('./character-assets.cjs')
        const originals = new Map(['assets/shared.png', 'assets/portrait.png'].map(key => [key, store.kvGet(key)]))
        const sourcePath = vi.fn((key: string, digest: string) => path.join(root, 'kv', 'objects', digest))
        const assets = createCharacterAssets({ dataRoot: root, sourceSize: (key: string) => originals.get(key).length,
            readOriginal: (key: string) => originals.get(key), sourcePath })
        assets.sync(db)
        const operations = commit.mock.calls.flatMap((call: any[]) => call[1])
        const copies = operations.filter((operation: any) => operation.path.includes('/assets/'))
        expect(copies).toHaveLength(2)
        for (const copy of copies) {
            expect(copy.data).toBeUndefined()
            expect(copy.sourcePath).toMatch(/[\\/]kv[\\/]objects[\\/][a-f0-9]{64}$/)
            expect(copy.expectedChecksum).toBe(path.basename(copy.sourcePath))
        }
        expect(sourcePath).toHaveBeenCalledTimes(2)
        expect(fs.readFileSync(path.join(directory, 'portrait.png')).toString()).toBe('portrait')
    } finally { commit.mockRestore(); delete require.cache[modulePath] }
})
it('syncs V3 app replacement and removal, preserves shared KV, and skips unchanged saves', () => {
    const { root, store, db, directory } = mappedFixture()
    expect(store.characterAssets.sync(db).changed).toBe(true)
    expect(fs.readFileSync(path.join(directory, 'portrait.png')).toString()).toBe('portrait')
    const read = vi.spyOn(fs, 'readFileSync')
    try {
        expect(store.characterAssets.sync(db).changed).toBe(false)
        expect(read).not.toHaveBeenCalled()
    } finally { read.mockRestore() }
    store.kvSet('assets/new.png', Buffer.from('new portrait'))
    db.characters[0].image = 'assets/new.png'
    store.characterAssets.sync(db)
    expect(fs.existsSync(path.join(directory, 'portrait.png'))).toBe(false)
    expect(fs.readFileSync(path.join(directory, 'new.png')).toString()).toBe('new portrait')
    expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
    expect(store.kvGet('assets/shared.png').toString()).toBe('shared')
    expect(fs.readFileSync(path.join(directory, 'shared.png')).toString()).toBe('shared')
    db.characters[0].image = ''
    db.characters[0].additionalAssets = []
    store.characterAssets.sync(db)
    expect(fs.existsSync(path.join(directory, 'new.png'))).toBe(false)
    const live = JSON.parse(fs.readFileSync(path.join(root, 'index/live-character-assets.json'), 'utf8'))
    expect(live.characters.one).toEqual({})
})
it('does not read asset bytes or rewrite indices after restart and reload with unchanged V3 assets', () => {
    const { root, store, db } = mappedFixture()
    store.characterAssets.sync(db)
    const reopened = createFileKv({ dataRoot: root })
    for (const assets of [reopened.characterAssets, store.characterAssets]) {
        assets.reload()
        const read = vi.spyOn(fs, 'readFileSync')
        const write = vi.spyOn(fs, 'renameSync')
        try {
            expect(assets.sync(db)).toEqual({ changed: false })
            expect(read.mock.calls.filter(([name]) => /[\\/]assets[\\/]|[\\/]kv[\\/]objects[\\/]/.test(String(name)))).toHaveLength(0)
            expect(write).not.toHaveBeenCalled()
        } finally { read.mockRestore(); write.mockRestore() }
    }
})
it('reads only added assets and retired copies when one reference changes in a large V3 character', () => {
    const { root, store, db, directory } = mappedFixture()
    for (let i = 0; i < 40; i++) {
        const key = `assets/keep-${i}.png`
        store.kvSet(key, Buffer.from(`keep-${i}`))
        db.characters[0].additionalAssets.push([`keep-${i}`, key, 'png'])
    }
    store.characterAssets.sync(db)
    store.characterAssets.reload()
    store.kvSet('assets/new.png', Buffer.from('new portrait'))
    db.characters[0].image = 'assets/new.png'
    const keepHashes = new Set(Array.from({ length: 40 }, (_, i) => crypto.createHash('sha256').update(`keep-${i}`).digest('hex')))
    const read = vi.spyOn(fs, 'readFileSync')
    try {
        store.characterAssets.sync(db)
        const unrelated = read.mock.calls.filter(([name]) => {
            const file = String(name)
            return file.startsWith(directory + path.sep) && /^keep-/.test(path.basename(file))
                || file.startsWith(path.join(root, 'kv/objects') + path.sep) && keepHashes.has(path.basename(file))
        })
        expect(unrelated).toHaveLength(0)
    } finally { read.mockRestore() }
    expect(fs.readFileSync(path.join(directory, 'new.png')).toString()).toBe('new portrait')
})
it('still verifies immutable KV content on use after the restarted delta fast path', () => {
    const { root, store, db, directory } = mappedFixture()
    store.characterAssets.sync(db)
    const reopened = createFileKv({ dataRoot: root })
    expect(reopened.characterAssets.sync(db).changed).toBe(false)
    const digest = crypto.createHash('sha256').update('portrait').digest('hex')
    fs.writeFileSync(path.join(root, 'kv/objects', digest), 'tampered')
    // The verified folder copy carries the expected digest; KV is only the fallback.
    expect(reopened.kvGet('assets/portrait.png').toString()).toBe('portrait')
    fs.unlinkSync(path.join(directory, 'portrait.png'))
    expect(() => reopened.kvGet('assets/portrait.png')).toThrow('checksum mismatch')
})
it('preserves external asset bytes when app removal races with an unadopted edit and retries', () => {
    const { store, db, directory } = mappedFixture()
    store.characterAssets.sync(db)
    const target = path.join(directory, 'portrait.png')
    fs.writeFileSync(target, 'external')
    db.characters[0].image = ''
    expect(() => store.characterAssets.sync(db)).toThrow('Asset changed outside the app')
    expect(fs.readFileSync(target).toString()).toBe('external')
    fs.writeFileSync(target, 'portrait')
    expect(store.characterAssets.sync(db).changed).toBe(true)
    expect(fs.existsSync(target)).toBe(false)
})
it('leaves legacy ID layouts and unknown files untouched during app asset sync', () => {
    const legacy = fixture()
    expect(legacy.store.characterAssets.sync(legacy.db).changed).toBe(false)
    expect(fs.existsSync(path.join(legacy.root, 'characters/one/assets'))).toBe(false)
    const { store, db, directory } = mappedFixture()
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'user.txt'), 'user')
    store.characterAssets.sync(db)
    expect(fs.readFileSync(path.join(directory, 'user.txt')).toString()).toBe('user')
})
it('invalidates the sync fast path when bytes change under the same KV key', () => {
    const { root, store, db, directory } = mappedFixture()
    db.characters[0].additionalAssets = []
    const { createCharacterAssets } = require('./character-assets.cjs')
    let bytes = Buffer.from('portrait')
    const assets = createCharacterAssets({ dataRoot: root, sourceSize: () => bytes.length,
        readOriginal: () => bytes, sourceVersion: () => bytes.toString() })
    assets.sync(db)
    bytes = Buffer.from('replacement')
    expect(assets.sync(db).changed).toBe(true)
    expect(fs.existsSync(path.join(directory, 'portrait.png'))).toBe(false)
    expect(fs.readFileSync(path.join(directory, 'portrait (2).png')).toString()).toBe('replacement')
    expect(store.kvGet('assets/shared.png').toString()).toBe('shared')
})
it('materializes independent copies of a shared asset in each V3 folder without removing the KV original', () => {
    const { root, store, db, directory } = mappedFixture()
    const { createUserDataRepository } = require('./user-data-repository.cjs')
    const repo = createUserDataRepository({ dataRoot: root, allowDirectoryMapping: true })
    const other = repo.publishCharacterDirectoryMapping('two')
    store.characterAssets.sync(db)
    const second = path.join(root, 'characters', other.directory, 'assets/shared.png')
    expect(fs.readFileSync(path.join(directory, 'shared.png')).toString()).toBe('shared')
    expect(fs.readFileSync(second).toString()).toBe('shared')
    db.characters[0].additionalAssets = []
    store.characterAssets.sync(db)
    expect(fs.existsSync(path.join(directory, 'shared.png'))).toBe(false)
    expect(fs.readFileSync(second).toString()).toBe('shared')
    expect(store.kvGet('assets/shared.png').toString()).toBe('shared')
})
it('does not serve unadopted same-size external edits through shared KV references', () => {
    const { root, store, db, directory } = mappedFixture()
    store.characterAssets.sync(db)
    // The other character remains unmapped but uses the exact same KV key.
    fs.writeFileSync(path.join(directory, 'shared.png'), 'edited')
    expect(store.kvGet('assets/shared.png').toString()).toBe('shared')
    expect(createFileKv({ dataRoot: root }).kvGet('assets/shared.png').toString()).toBe('shared')
    expect(fs.readFileSync(path.join(directory, 'shared.png')).toString()).toBe('edited')
})
it('recovers interrupted asset publication before retrying without duplicating or resurrecting files', () => {
    const { root, store, db, directory } = mappedFixture()
    db.characters[0].additionalAssets = []
    store.characterAssets.sync(db)
    store.kvSet('assets/new.png', Buffer.from('new'))
    db.characters[0].image = 'assets/new.png'
    const index = path.join(root, 'index/character-asset-replicas.json')
    const rename = fs.renameSync
    let failed = false
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (!failed && String(to) === index) { failed = true; throw new Error('interrupted publication') }
        return rename(from, to)
    })
    try { expect(() => store.characterAssets.sync(db)).toThrow('interrupted publication') }
    finally { spy.mockRestore() }
    store.characterAssets.sync(db)
    expect(fs.existsSync(path.join(directory, 'portrait.png'))).toBe(false)
    expect(fs.readFileSync(path.join(directory, 'new.png')).toString()).toBe('new')
    expect(fs.readdirSync(directory).filter(name => name.endsWith('.png'))).toEqual(['new.png'])
    const live = JSON.parse(fs.readFileSync(path.join(root, 'index/live-character-assets.json'), 'utf8'))
    expect(Object.keys(live.characters.one)).toEqual(['new.png'])
})
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
it('reads a verified replica with one open and no hash, path stat or metadata existence lookup', () => {
    const { store, db } = fixture()
    store.characterAssets.migrate(db, 'one', store.kvGet)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    try {
        expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
        expect(store.characterAssets.diagnostics().verified).toBe(1)
        const open = vi.spyOn(fs, 'openSync')
        const read = vi.spyOn(fs, 'readFileSync')
        const stat = vi.spyOn(fs, 'statSync')
        const lstat = vi.spyOn(fs, 'lstatSync')
        const exists = vi.spyOn(fs, 'existsSync')
        const digest = vi.spyOn(crypto, 'createHash')
        expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
        expect(open).toHaveBeenCalledTimes(1)
        expect(read).not.toHaveBeenCalled()
        expect(stat).not.toHaveBeenCalled()
        expect(lstat).not.toHaveBeenCalled()
        expect(exists).not.toHaveBeenCalled()
        expect(digest).not.toHaveBeenCalled()
        expect(store.characterAssets.diagnostics()).toMatchObject({ reads: 2, verified: 1, fallbacks: 0 })
    } finally { vi.restoreAllMocks() }
})
it('never serves same-size external changes and repairs them from original KV on revalidation', () => {
    const { root, store, db } = fixture()
    store.characterAssets.migrate(db, 'one', store.kvGet)
    const index = path.join(root, 'index', 'character-asset-replicas.json')
    const old = JSON.parse(fs.readFileSync(index, 'utf8')).characters.one.entries[0]
    fs.writeFileSync(path.join(root, 'characters', 'one', 'assets', old.filename), 'modified')
    expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
    expect(store.characterAssets.diagnostics()).toMatchObject({ reads: 0, rejected: 1, fallbacks: 1 })
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
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    try {
        expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
        const open = vi.spyOn(fs, 'openSync')
        const stat = vi.spyOn(fs, 'statSync')
        const lstat = vi.spyOn(fs, 'lstatSync')
        expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
        expect(open).toHaveBeenCalledTimes(1)
        expect(String(open.mock.calls[0][0])).toContain(mapped.directory)
        expect(stat).not.toHaveBeenCalled()
        expect(lstat).not.toHaveBeenCalled()
    } finally { vi.restoreAllMocks() }
    expect(createFileKv({ dataRoot: root }).kvGet('assets/portrait.png').toString()).toBe('portrait')
    expect(store.characterAssets.migrate(db, 'one', store.kvGet).copied).toBe(1)
})

function objectReads(read: any, root: string) {
    return read.mock.calls.filter(([name]: any[]) => String(name).startsWith(path.join(root, 'kv', 'objects') + path.sep))
}
it('serves sync-managed V3 copies from the folder without reading the KV object', () => {
    const { root, store, db } = mappedFixture()
    store.characterAssets.sync(db)
    const read = vi.spyOn(fs, 'readFileSync')
    try {
        expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
        expect(store.kvGet('assets/shared.png').toString()).toBe('shared')
        expect(objectReads(read, root)).toHaveLength(0)
    } finally { read.mockRestore() }
    expect(store.characterAssets.diagnostics()).toMatchObject({ folderReads: true, reads: 2, verified: 2, fallbacks: 0, rejected: 0 })
})
it('keeps folder reads after saves and a restart without rewriting the replica index', () => {
    const { root, store, db } = mappedFixture()
    store.characterAssets.sync(db)
    const index = path.join(root, 'index', 'character-asset-replicas.json')
    const before = fs.readFileSync(index)
    expect(store.characterAssets.sync(db).changed).toBe(false)
    const reopened = createFileKv({ dataRoot: root })
    expect(reopened.characterAssets.sync(db).changed).toBe(false)
    expect(fs.readFileSync(index)).toEqual(before)
    const read = vi.spyOn(fs, 'readFileSync')
    try {
        expect(reopened.kvGet('assets/portrait.png').toString()).toBe('portrait')
        expect(objectReads(read, root)).toHaveLength(0)
    } finally { read.mockRestore() }
    expect(reopened.characterAssets.diagnostics()).toMatchObject({ reads: 1, fallbacks: 0 })
})
it('falls back to KV when a trusted copy changes behind an unchanged size and modification time', () => {
    const { root, store, db, directory } = mappedFixture()
    store.characterAssets.sync(db)
    const target = path.join(directory, 'portrait.png')
    const old = new Date(Date.now() - 3_600_000)
    fs.utimesSync(target, old, old)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    try {
        expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
        // The mocked clock trusts a just-changed file. Real trust needs a 5-second-old
        // change, so wait past the OS timestamp tick (about 15ms on Windows) before editing.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
        fs.writeFileSync(target, 'PORTRAIT')
        fs.utimesSync(target, old, old)
        const read = vi.spyOn(fs, 'readFileSync')
        expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
        expect(objectReads(read, root)).toHaveLength(1)
        // A known-bad signature falls back without hashing the copy again.
        const digest = vi.spyOn(crypto, 'createHash')
        expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
        expect(digest.mock.calls.length).toBe(1)
    } finally { vi.restoreAllMocks() }
    expect(store.characterAssets.diagnostics()).toMatchObject({ verified: 1, rejected: 1, fallbacks: 2 })
    expect(fs.readFileSync(target).toString()).toBe('PORTRAIT')
})
it('falls back to KV without an error when a copy is deleted, resized or replaced by a directory', () => {
    const { store, db, directory } = mappedFixture()
    store.characterAssets.sync(db)
    fs.unlinkSync(path.join(directory, 'portrait.png'))
    expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
    fs.writeFileSync(path.join(directory, 'shared.png'), 'shared and longer')
    expect(store.kvGet('assets/shared.png').toString()).toBe('shared')
    fs.unlinkSync(path.join(directory, 'shared.png'))
    fs.mkdirSync(path.join(directory, 'shared.png'))
    expect(store.kvGet('assets/shared.png').toString()).toBe('shared')
    expect(store.characterAssets.diagnostics()).toMatchObject({ reads: 0, fallbacks: 3 })
})
it('serves a shared key only from a verified copy and never from another character edit', () => {
    const { root, store, db, directory } = mappedFixture()
    const { createUserDataRepository } = require('./user-data-repository.cjs')
    const repo = createUserDataRepository({ dataRoot: root, allowDirectoryMapping: true })
    const other = repo.publishCharacterDirectoryMapping('two')
    store.characterAssets.sync(db)
    const copies = [path.join(directory, 'shared.png'), path.join(root, 'characters', other.directory, 'assets/shared.png')]
    for (const copy of copies) fs.writeFileSync(copy, 'edited')
    expect(store.kvGet('assets/shared.png').toString()).toBe('shared')
    expect(createFileKv({ dataRoot: root }).kvGet('assets/shared.png').toString()).toBe('shared')
    for (const copy of copies) expect(fs.readFileSync(copy).toString()).toBe('edited')
    expect(store.characterAssets.diagnostics()).toMatchObject({ reads: 0, rejected: 1 })
})
it('restores KV reads for sync-managed copies when folder reads are switched off', () => {
    const { root, store, db } = mappedFixture()
    store.characterAssets.sync(db)
    const previous = process.env.RISUBARD_ASSET_FOLDER_READS
    process.env.RISUBARD_ASSET_FOLDER_READS = '0'
    try {
        const reopened = createFileKv({ dataRoot: root })
        const read = vi.spyOn(fs, 'readFileSync')
        try {
            expect(reopened.kvGet('assets/portrait.png').toString()).toBe('portrait')
            expect(objectReads(read, root)).toHaveLength(1)
        } finally { read.mockRestore() }
        expect(reopened.characterAssets.diagnostics()).toMatchObject({ folderReads: false, reads: 0, fallbacks: 0 })
        expect(reopened.characterAssets.sync(db).changed).toBe(false)
    } finally {
        if (previous === undefined) delete process.env.RISUBARD_ASSET_FOLDER_READS
        else process.env.RISUBARD_ASSET_FOLDER_READS = previous
    }
})

function manifestKeys(root: string) {
    return Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'kv', 'manifest.json'), 'utf8')).entries)
}
function retireOne() {
    const value = mappedFixture()
    value.store.characterAssets.sync(value.db)
    const plan = value.store.characterAssets.retirementCandidates(value.db, 'one')
    const moved = value.store.retireAssets('one', plan.candidates)
    return { ...value, plan, moved }
}
it('V4 retires only verified, unshared copies and keeps every KV API answer unchanged', () => {
    const { root, store, plan, moved } = retireOne()
    expect(plan).toMatchObject({ shared: 1, unverified: 0 })
    expect(plan.candidates.map((entry: any) => entry.key)).toEqual(['assets/portrait.png'])
    expect(moved).toEqual({ retired: 1 })
    expect(manifestKeys(root)).not.toContain('assets/portrait.png')
    expect(manifestKeys(root)).toContain('assets/shared.png')
    expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
    expect(store.kvList('assets/')).toEqual(['assets/portrait.png', 'assets/shared.png'])
    expect(store.kvListWithSizes('assets/')).toEqual([{ key: 'assets/portrait.png', size: 8 }, { key: 'assets/shared.png', size: 6 }])
    expect(store.kvSize('assets/portrait.png')).toBe(8)
    expect(store.retiredStatus('one')).toEqual({ retired: 1, bytes: 8 })
})
it('V4 survives restart and saves, and reads the kept object when folder reads are off', () => {
    const { root, db, directory } = retireOne()
    const reopened = createFileKv({ dataRoot: root })
    expect(reopened.characterAssets.sync(db).changed).toBe(false)
    expect(reopened.kvGet('assets/portrait.png').toString()).toBe('portrait')
    expect(reopened.characterAssets.diagnostics().reads).toBe(1)
    fs.unlinkSync(path.join(directory, 'portrait.png'))
    expect(reopened.kvGet('assets/portrait.png').toString()).toBe('portrait')
    const previous = process.env.RISUBARD_ASSET_FOLDER_READS
    process.env.RISUBARD_ASSET_FOLDER_READS = '0'
    try { expect(createFileKv({ dataRoot: root }).kvGet('assets/portrait.png').toString()).toBe('portrait') }
    finally {
        if (previous === undefined) delete process.env.RISUBARD_ASSET_FOLDER_READS
        else process.env.RISUBARD_ASSET_FOLDER_READS = previous
    }
})
it('V4 keeps retired objects through garbage collection and restores them into the manifest', () => {
    const { root, store } = retireOne()
    const object = crypto.createHash('sha256').update('portrait').digest('hex')
    store.gcChunks({})
    expect(fs.existsSync(path.join(root, 'kv', 'objects', object))).toBe(true)
    expect(store.restoreRetiredAssets('one', () => null)).toEqual({ restored: 1, failed: 0 })
    expect(manifestKeys(root)).toContain('assets/portrait.png')
    expect(store.retiredStatus('one')).toEqual({ retired: 0, bytes: 0 })
    expect(createFileKv({ dataRoot: root }).kvGet('assets/portrait.png').toString()).toBe('portrait')
})
it('V4 restore rebuilds a missing object only from digest-matching bytes', () => {
    const { root, store, directory } = retireOne()
    const object = path.join(root, 'kv', 'objects', crypto.createHash('sha256').update('portrait').digest('hex'))
    fs.unlinkSync(object)
    expect(store.restoreRetiredAssets('one', () => Buffer.from('PORTRAIT'))).toEqual({ restored: 0, failed: 1 })
    expect(manifestKeys(root)).not.toContain('assets/portrait.png')
    expect(store.retiredStatus('one').retired).toBe(1)
    expect(store.restoreRetiredAssets('one', (key: string, entry: any) => store.characterAssets.read(key, entry))).toEqual({ restored: 1, failed: 0 })
    expect(fs.readFileSync(object).toString()).toBe('portrait')
    fs.unlinkSync(path.join(directory, 'portrait.png'))
    expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
})
it('V4 deletion and prefix replacement remove retired keys like manifest keys', () => {
    const first = retireOne()
    const object = path.join(first.root, 'kv', 'objects', crypto.createHash('sha256').update('portrait').digest('hex'))
    expect(first.store.kvDelManyAndCollect(['assets/portrait.png'])).toMatchObject({ count: 1, bytes: 8 })
    expect(first.store.kvGet('assets/portrait.png')).toBeNull()
    expect(first.store.kvList('assets/')).toEqual(['assets/shared.png'])
    expect(fs.existsSync(object)).toBe(false)
    expect(createFileKv({ dataRoot: first.root }).kvList('assets/')).toEqual(['assets/shared.png'])
    const second = retireOne()
    second.store.kvReplacePrefixes([{ key: 'assets/other.png', value: Buffer.from('other') }], ['assets/'])
    expect(second.store.kvList('assets/')).toEqual(['assets/other.png'])
    expect(second.store.retiredStatus('one').retired).toBe(0)
})
it('V4 publishes retired index changes with a prepared backup restore manifest', async () => {
    const { store } = retireOne()
    const prepared = await store.preparePrefixReplacementFromFilesAsync([], ['assets/'])
    expect(JSON.parse(prepared.retiredBytes.toString()).characters).toEqual({})
    const untouched = await store.preparePrefixReplacementFromFilesAsync([], ['drafts/'])
    expect(untouched.retiredBytes).toBeUndefined()
})
it('V4 never creates a retired index without an explicit transition', () => {
    const { root, store, db } = mappedFixture()
    store.characterAssets.sync(db)
    store.kvDel('assets/shared.png')
    store.kvReplacePrefixes([], ['drafts/'])
    store.gcChunks({})
    expect(fs.existsSync(path.join(root, 'kv', 'retired-assets.json'))).toBe(false)
})
it('V4 refuses changed copies and characters without a V3 package', () => {
    const value = mappedFixture()
    value.store.characterAssets.sync(value.db)
    fs.writeFileSync(path.join(value.directory, 'portrait.png'), 'PORTRAIT')
    expect(value.store.characterAssets.retirementCandidates(value.db, 'one')).toMatchObject({ candidates: [], shared: 1, unverified: 1 })
    const legacy = fixture()
    legacy.store.characterAssets.migrate(legacy.db, 'one', legacy.store.kvGet)
    expect(() => legacy.store.characterAssets.retirementCandidates(legacy.db, 'one')).toThrow('V3 character package')
})
it('V4 characters keep saving new and replaced assets through KV', () => {
    const { root, store, db, directory } = retireOne()
    store.kvSet('assets/new.png', Buffer.from('new portrait'))
    db.characters[0].image = 'assets/new.png'
    expect(store.characterAssets.sync(db).changed).toBe(true)
    expect(fs.readFileSync(path.join(directory, 'new.png')).toString()).toBe('new portrait')
    expect(store.kvGet('assets/portrait.png').toString()).toBe('portrait')
    expect(createFileKv({ dataRoot: root }).kvGet('assets/new.png').toString()).toBe('new portrait')
})
it('V4 treats any outside reference, including a longer suffixed one, as shared', () => {
    const value = mappedFixture()
    value.store.characterAssets.sync(value.db)
    const candidates = (database: any) => value.store.characterAssets.retirementCandidates(database, 'one').candidates.map((entry: any) => entry.key)
    expect(candidates(value.db)).toEqual(['assets/portrait.png'])
    expect(candidates({ ...value.db, modules: [{ assets: [['x', 'assets/portrait.png', 'png']] }] })).toEqual([])
    expect(candidates({ ...value.db, css: 'url(xassets/aassets/portrait.png.bak)' })).toEqual([])
    expect(candidates({ ...value.db, css: 'url(assets/portrait.pn)' })).toEqual(['assets/portrait.png'])
})

function moduleFixture() {
    const value = fixture()
    value.store.kvSet('assets/m1.png', Buffer.from('module one'))
    const db: any = { ...value.db, modules: [
        { id: 'mod', name: 'Fate 에셋', assets: [['first', 'assets/m1.png', 'png'], ['second', 'assets/shared.png', 'png']] },
        { id: 'twin', name: 'Fate 에셋', assets: [] },
    ] }
    return { ...value, db, directory: path.join(value.root, 'modules', 'Fate 에셋', 'assets') }
}
it('module folders copy verified assets, serve them, and leave KV and module JSON untouched', async () => {
    const { root, store, db, directory } = moduleFixture()
    const manifest = fs.readFileSync(path.join(root, 'kv', 'manifest.json'))
    expect(await store.characterAssets.migrateModule(db, 'mod')).toEqual({ enabled: true, directory: 'Fate 에셋', copied: 2, failed: 0 })
    expect(fs.readFileSync(path.join(directory, 'first.png')).toString()).toBe('module one')
    expect(fs.readFileSync(path.join(root, 'kv', 'manifest.json'))).toEqual(manifest)
    expect(fs.existsSync(path.join(root, 'modules', 'mod.json'))).toBe(false)
    expect(store.kvGet('assets/m1.png').toString()).toBe('module one')
    expect(store.characterAssets.diagnostics()).toMatchObject({ reads: 1, verified: 1 })
    fs.writeFileSync(path.join(directory, 'first.png'), 'MODULE ONE')
    expect(createFileKv({ dataRoot: root }).kvGet('assets/m1.png').toString()).toBe('module one')
    expect((await store.characterAssets.migrateModule(db, 'twin')).directory).toBe('Fate 에셋 (2)')
    expect(store.characterAssets.overview().modules).toEqual({
        mod: { enabled: true, copied: 2, failed: 0 }, twin: { enabled: true, copied: 0, failed: 0 },
    })
})
it('module refresh reuses verified copies and repairs changed ones', async () => {
    const { store, db, directory } = moduleFixture()
    await store.characterAssets.migrateModule(db, 'mod')
    const write = vi.spyOn(fs.promises, 'rename')
    try {
        await store.characterAssets.migrateModule(db, 'mod')
        expect(write).not.toHaveBeenCalled()
    } finally { write.mockRestore() }
    fs.writeFileSync(path.join(directory, 'first.png'), 'MODULE ONE')
    await store.characterAssets.migrateModule(db, 'mod')
    expect(store.kvGet('assets/m1.png').toString()).toBe('module one')
    expect(store.characterAssets.diagnostics().rejected).toBe(0)
})
it('module V4 retires only module-owned keys, survives restart, and restores', async () => {
    const { root, store, db } = moduleFixture()
    await store.characterAssets.migrateModule(db, 'mod')
    const plan = await store.characterAssets.moduleRetirementCandidates(db, 'mod')
    expect(plan).toMatchObject({ shared: 1, unverified: 0 })
    expect(store.retireAssets('module:mod', plan.candidates)).toEqual({ retired: 1 })
    expect(store.retiredSummary()).toEqual({ 'module:mod': 1 })
    expect(manifestKeys(root)).not.toContain('assets/m1.png')
    const reopened = createFileKv({ dataRoot: root })
    expect(reopened.kvGet('assets/m1.png').toString()).toBe('module one')
    expect(reopened.kvList('assets/')).toContain('assets/m1.png')
    expect(reopened.restoreRetiredAssets('module:mod', () => null)).toEqual({ restored: 1, failed: 0 })
    expect(manifestKeys(root)).toContain('assets/m1.png')
})
it('module folder reads stop when disabled or when folder reads are switched off', async () => {
    const { root, store, db } = moduleFixture()
    await store.characterAssets.migrateModule(db, 'mod')
    store.characterAssets.disableModule('mod')
    expect(store.kvGet('assets/m1.png').toString()).toBe('module one')
    expect(store.characterAssets.diagnostics().reads).toBe(0)
    await store.characterAssets.migrateModule(db, 'mod')
    const previous = process.env.RISUBARD_ASSET_FOLDER_READS
    process.env.RISUBARD_ASSET_FOLDER_READS = '0'
    try {
        const reopened = createFileKv({ dataRoot: root })
        expect(reopened.kvGet('assets/m1.png').toString()).toBe('module one')
        expect(reopened.characterAssets.diagnostics().reads).toBe(0)
    } finally {
        if (previous === undefined) delete process.env.RISUBARD_ASSET_FOLDER_READS
        else process.env.RISUBARD_ASSET_FOLDER_READS = previous
    }
})
it('module V4 keeps keys used by persona-embedded copies or other modules', async () => {
    const { store, db } = moduleFixture()
    await store.characterAssets.migrateModule(db, 'mod')
    const keys = async (database: any) => (await store.characterAssets.moduleRetirementCandidates(database, 'mod')).candidates.map((entry: any) => entry.key)
    expect(await keys(db)).toEqual(['assets/m1.png'])
    expect(await keys({ ...db, personas: [{ embeddedModule: { assets: [['x', 'assets/m1.png', 'png']] } }] })).toEqual([])
    expect(await keys({ ...db, modules: [...db.modules, { id: 'other', name: 'o', assets: [['x', 'assets/m1.png', 'png']] }] })).toEqual([])
})
it('module copies refuse a second concurrent run and leave no sidecar files', async () => {
    const { store, db, directory } = moduleFixture()
    const plan = store.characterAssets.prepareModuleCopy(db, 'mod')
    expect(() => store.characterAssets.prepareModuleCopy(db, 'mod')).toThrow('already running')
    store.characterAssets.publishModuleCopy(plan, await store.characterAssets.copyModule(plan))
    store.characterAssets.releaseModuleCopy(plan)
    expect(fs.readdirSync(directory).sort()).toEqual(['first.png', 'second.png'])
    expect(store.characterAssets.prepareModuleCopy(db, 'mod').id).toBe('mod')
})
function trashed(root: string) {
    const trash = path.join(root, 'trash')
    if (!fs.existsSync(trash)) return []
    return fs.readdirSync(trash).filter(name => name.startsWith('module-assets-'))
        .flatMap(name => fs.readdirSync(path.join(trash, name), { recursive: true }).map(file => `${name.replace(/-[0-9a-f-]+$/, '')}/${String(file).replace(/\\/g, '/')}`))
}
it('module folders pick up added and removed assets in the background after a save', async () => {
    const { root, store, db, directory } = moduleFixture()
    await store.characterAssets.migrateModule(db, 'mod')
    store.kvSet('assets/m2.png', Buffer.from('module two'))
    db.modules[0].assets = [['second', 'assets/shared.png', 'png'], ['third', 'assets/m2.png', 'png']]
    store.characterAssets.scheduleModuleSync(db)
    await store.characterAssets.moduleSyncIdle()
    expect(fs.readdirSync(directory).sort()).toEqual(['second.png', 'third.png'])
    expect(trashed(root)).toContain('module-assets/Fate 에셋/first.png')
    expect(store.kvGet('assets/m2.png').toString()).toBe('module two')
    expect(store.kvGet('assets/m1.png').toString()).toBe('module one')
    expect(store.characterAssets.diagnostics().reads).toBe(1)
    const index = path.join(root, 'index', 'module-asset-replicas.json')
    const before = fs.readFileSync(index)
    store.characterAssets.scheduleModuleSync(db)
    await store.characterAssets.moduleSyncIdle()
    expect(fs.readFileSync(index)).toEqual(before)
    expect(before.toString()).not.toContain('\n  ')
})
it('module folders of deleted modules move to trash only when the module file is also gone', async () => {
    const { root, store, db } = moduleFixture()
    await store.characterAssets.migrateModule(db, 'mod')
    fs.writeFileSync(path.join(root, 'modules', 'mod.json'), '{}')
    store.characterAssets.scheduleModuleSync({ ...db, modules: [] })
    await store.characterAssets.moduleSyncIdle()
    expect(store.characterAssets.moduleStatus('mod').enabled).toBe(true)
    fs.unlinkSync(path.join(root, 'modules', 'mod.json'))
    store.characterAssets.scheduleModuleSync({ ...db, modules: [] })
    await store.characterAssets.moduleSyncIdle()
    expect(store.characterAssets.moduleStatus('mod')).toEqual({ enabled: false, directory: '', copied: 0, failed: 0 })
    expect(fs.existsSync(path.join(root, 'modules', 'Fate 에셋'))).toBe(false)
    expect(trashed(root)).toContain('module-assets/Fate 에셋/assets/first.png')
    expect(store.kvGet('assets/m1.png').toString()).toBe('module one')
})
it('module background sync keeps a user choice to turn the folder off', async () => {
    const { store, db } = moduleFixture()
    await store.characterAssets.migrateModule(db, 'mod')
    store.characterAssets.disableModule('mod')
    store.kvSet('assets/m2.png', Buffer.from('module two'))
    db.modules[0].assets.push(['third', 'assets/m2.png', 'png'])
    store.characterAssets.scheduleModuleSync(db)
    await store.characterAssets.moduleSyncIdle()
    expect(store.characterAssets.moduleStatus('mod')).toMatchObject({ enabled: false, copied: 2 })
})
it('character route rebuilds keep module routes, and changed module copies fall back to KV', async () => {
    const { store, db, root } = moduleFixture()
    await store.characterAssets.migrateModule(db, 'mod')
    store.characterAssets.migrate(db, 'one', store.kvGet)
    fs.writeFileSync(path.join(root, 'modules', 'Fate 에셋', 'assets', 'second.png'), 'SHARED')
    expect(store.kvGet('assets/shared.png').toString()).toBe('shared')
    expect(store.kvGet('assets/m1.png').toString()).toBe('module one')
    expect(store.characterAssets.diagnostics()).toMatchObject({ reads: 1, rejected: 1 })
})
it('module index is parsed again on reload only after it changes on disk', async () => {
    const { root, store, db } = moduleFixture()
    await store.characterAssets.migrateModule(db, 'mod')
    store.characterAssets.reload()
    expect(store.kvGet('assets/m1.png').toString()).toBe('module one')
    expect(store.characterAssets.diagnostics().reads).toBe(1)
    for (const name of ['module-asset-replicas.json', 'module-asset-replicas.json.sha256']) fs.rmSync(path.join(root, 'index', name), { force: true })
    store.characterAssets.reload()
    expect(store.characterAssets.moduleStatus('mod').enabled).toBe(false)
    expect(store.kvGet('assets/m1.png').toString()).toBe('module one')
    expect(store.characterAssets.diagnostics().reads).toBe(1)
})
