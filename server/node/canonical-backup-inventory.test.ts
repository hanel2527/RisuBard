import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { atomicWriteJson, atomicWriteFile, commitTransaction } = require('./file-store.cjs')
const { decodeCanonicalBackupName } = require('./canonical-backup-name.cjs')
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })) })
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-inventory-')); roots.push(value); return value }
function fixture() {
    const dataRoot = root()
    const repo = createUserDataRepository({ dataRoot, allowDirectoryMapping: true })
    repo.importLegacyDatabase({ language: 'ko', characters: [{ chaId: 'char-1', name: 'Alice', chats: [{ id: 'chat-1', name: 'First chat', message: [{ role: 'user', data: 'hello' }] }] }] })
    return { dataRoot, repo }
}
function list(dataRoot: string) { return require('./canonical-backup-inventory.cjs').listCanonicalBackupEntries(dataRoot) }
const portable = (entries: any[]) => entries.map(entry => decodeCanonicalBackupName(entry.backupName))
it('preserves the legacy inventory shape, ordering and flat names while excluding only temporary/checksum files', async () => {
    const dataRoot = root()
    for (const name of ['settings/app.json', 'secrets/key.json', 'characters/one/chats/two/draft.json', 'risubard/wiki/history/old.md', 'trash/old/file.json', 'index/sidebar.json.bak', 'model-jobs/job/state.json']) atomicWriteFile(dataRoot, name, Buffer.from(name))
    atomicWriteFile(dataRoot, 'characters/one/unfinished.tmp', Buffer.from('temp'))
    atomicWriteFile(dataRoot, 'kv/objects/excluded', Buffer.from('kv'))
    const entries = await list(dataRoot)
    expect(portable(entries)).toEqual(['characters/one/chats/two/draft.json', 'index/sidebar.json.bak', 'model-jobs/job/state.json', 'risubard/wiki/history/old.md', 'secrets/key.json', 'settings/app.json', 'trash/old/file.json'])
    for (const entry of entries) {
        expect(entry).toEqual({ kind: 'canonical', sourcePath: path.join(dataRoot, decodeCanonicalBackupName(entry.backupName)), backupName: entry.backupName, sortKey: `risubard-data/${decodeCanonicalBackupName(entry.backupName)}`, size: fs.statSync(entry.sourcePath).size })
        expect(entry.backupName).not.toContain('/')
    }
})
it('roundtrips current mapped files through flat names without retired character/chat resurrection', async () => {
    const { dataRoot, repo } = fixture()
    repo.saveAssistantDraft('char-1', 'chat-1', { role: 'char', data: 'draft' })
    repo.publishCharacterDirectoryMapping('char-1')
    fs.cpSync(path.join(dataRoot, 'characters/char-1/chats/chat-1'), path.join(dataRoot, 'characters/Alice/chats/chat-1'), { recursive: true })
    atomicWriteFile(dataRoot, 'risubard/wiki/history/test.md', Buffer.from('history'))
    atomicWriteFile(dataRoot, 'characters/Alice/assets/Portrait.png', Buffer.from([0, 12, 255, 42]))
    atomicWriteJson(dataRoot, 'modules/global.json', { id: 'global' })
    repo.reconcileCanonicalProjection()
    const entries = await list(dataRoot)
    const names = portable(entries)
    expect(names).toContain('characters/Alice/chats/First chat/draft.json')
    expect(names).toContain('risubard/wiki/history/test.md')
    expect(names).toContain('modules/global.json')
    expect(names.some(name => name.startsWith('characters/char-1/'))).toBe(false)
    expect(names.some(name => name.startsWith('characters/Alice/chats/chat-1/'))).toBe(false)
    expect(fs.existsSync(path.join(dataRoot, 'characters/char-1'))).toBe(true)
    const restored = root()
    commitTransaction(restored, entries.map(entry => ({ path: decodeCanonicalBackupName(entry.backupName), data: fs.readFileSync(entry.sourcePath) })))
    for (const entry of entries) expect(fs.readFileSync(path.join(restored, decodeCanonicalBackupName(entry.backupName)))).toEqual(fs.readFileSync(entry.sourcePath))
    expect(createUserDataRepository({ dataRoot: restored }).exportLegacyDatabase()).toEqual(repo.exportLegacyDatabase())
    expect(createUserDataRepository({ dataRoot: restored }).loadAssistantDraft('char-1', 'chat-1').data).toBe('draft')
    repo.importLegacyDatabase({ characters: [] }, { mode: 'replace' })
    const deleted = await list(dataRoot)
    expect(portable(deleted).some(name => name.startsWith('characters/'))).toBe(false)
    expect(portable(deleted).some(name => name.startsWith('trash/'))).toBe(true)
    const afterDelete = root()
    commitTransaction(afterDelete, deleted.map(entry => ({ path: decodeCanonicalBackupName(entry.backupName), data: fs.readFileSync(entry.sourcePath) })))
    expect(createUserDataRepository({ dataRoot: afterDelete }).exportLegacyDatabase().characters).toEqual([])
})
it('preserves all characters through partial migration, restart, backup restore and rollback', async () => {
    const { dataRoot, repo } = fixture()
    const database = repo.exportLegacyDatabase()
    database.characters.push({ chaId: 'char-2', name: 'Alice', chats: [{ id: 'chat-2', name: 'First chat', message: [{ role: 'char', data: 'second character' }] }] })
    repo.importLegacyDatabase(database)
    repo.publishCharacterDirectoryMapping('char-1')
    const resumed = createUserDataRepository({ dataRoot, allowDirectoryMapping: true })
    expect(resumed.characterDirectoryStatus('char-1').enabled).toBe(true)
    expect(resumed.characterDirectoryStatus('char-2').enabled).toBe(false)
    resumed.publishCharacterDirectoryMapping('char-2')
    expect(resumed.characterDirectoryStatus('char-1').directory).not.toBe(resumed.characterDirectoryStatus('char-2').directory)
    const edited = resumed.exportLegacyDatabase()
    for (const character of edited.characters) character.chats[0].message.push({ role: 'user', data: `after migration ${character.chaId}` })
    resumed.importLegacyDatabase(edited, { mode: 'sync' })
    const restored = root()
    const entries = await list(dataRoot)
    commitTransaction(restored, entries.map(entry => ({ path: decodeCanonicalBackupName(entry.backupName), data: fs.readFileSync(entry.sourcePath) })))
    for (const entry of entries) expect(fs.readFileSync(path.join(restored, decodeCanonicalBackupName(entry.backupName)))).toEqual(fs.readFileSync(entry.sourcePath))
    const recovered = createUserDataRepository({ dataRoot: restored, allowDirectoryMapping: true })
    expect(recovered.exportLegacyDatabase()).toEqual(edited)
    for (const character of edited.characters) {
        expect(recovered.characterDirectoryStatus(character.chaId).enabled).toBe(true)
        recovered.rollbackCharacterDirectoryMapping(character.chaId)
    }
    expect(createUserDataRepository({ dataRoot: restored }).exportLegacyDatabase()).toEqual(edited)
})

it('rejects corrupt or missing published mapping and missing/empty checksum sidecars', async () => {
    const { dataRoot, repo } = fixture()
    repo.publishCharacterDirectoryMapping('char-1')
    await list(dataRoot)
    const index = path.join(dataRoot, 'index/character-directories.json')
    const bytes = fs.readFileSync(index)
    fs.writeFileSync(index, '{}')
    await expect(list(dataRoot)).rejects.toThrow()
    fs.writeFileSync(index, bytes)
    fs.writeFileSync(`${index}.sha256`, '')
    await expect(list(dataRoot)).rejects.toThrow(/checksum/)
    fs.unlinkSync(`${index}.sha256`)
    await expect(list(dataRoot)).rejects.toThrow(/checksum/)
    fs.unlinkSync(index)
    await expect(list(dataRoot)).rejects.toThrow(/missing/)
})
it('propagates real directory read errors while allowing absent optional roots', async () => {
    const dataRoot = root()
    expect(await list(dataRoot)).toEqual([])
    atomicWriteJson(dataRoot, 'settings/app.json', {})
    const original = fsp.readdir
    vi.spyOn(fsp, 'readdir').mockImplementation(((location, ...args) => {
        if (String(location) === path.join(dataRoot, 'settings')) return Promise.reject(Object.assign(new Error('access denied'), { code: 'EACCES' }))
        return (original as any)(location, ...args)
    }) as any)
    await expect(list(dataRoot)).rejects.toThrow(/access denied/)
})
it('rejects mapping publication during inventory traversal', async () => {
    const { dataRoot, repo } = fixture()
    const original = fsp.readdir
    let changed = false
    vi.spyOn(fsp, 'readdir').mockImplementation((async (location, ...args) => {
        const entries = await (original as any)(location, ...args)
        if (!changed && String(location) === path.join(dataRoot, 'settings')) { changed = true; repo.publishCharacterDirectoryMapping('char-1') }
        return entries
    }) as any)
    await expect(list(dataRoot)).rejects.toThrow(/mapping.*changed/i)
})
it('rejects symlinked canonical roots instead of including outside files', async () => {
    const dataRoot = root(), outside = root()
    fs.writeFileSync(path.join(outside, 'private.json'), 'private')
    fs.symlinkSync(outside, path.join(dataRoot, 'settings'), 'junction')
    await expect(list(dataRoot)).rejects.toThrow(/symbolic link/)
})

it('rejects nested directory disappearance rather than silently returning an incomplete inventory', async () => {
    const dataRoot = root()
    atomicWriteFile(dataRoot, 'risubard/wiki/document.md', Buffer.from('wiki'))
    const original = fsp.readdir
    vi.spyOn(fsp, 'readdir').mockImplementation(((location, ...args) => {
        if (String(location) === path.join(dataRoot, 'risubard/wiki')) return Promise.reject(Object.assign(new Error('nested directory disappeared'), { code: 'ENOENT' }))
        return (original as any)(location, ...args)
    }) as any)
    await expect(list(dataRoot)).rejects.toThrow(/disappeared/)
})

it('rejects case-insensitive inventory collisions for portable restore', async () => {
    const dataRoot = root()
    atomicWriteJson(dataRoot, 'settings/app.json', {})
    const original = fsp.readdir
    vi.spyOn(fsp, 'readdir').mockImplementation((async (location, ...args) => {
        const entries = await (original as any)(location, ...args)
        if (String(location) === path.join(dataRoot, 'settings')) entries.push({ name: 'APP.JSON', isSymbolicLink: () => false })
        return entries
    }) as any)
    await expect(list(dataRoot)).rejects.toThrow(/collision/)
})

it('rejects mapping path escape before inventory traversal', async () => {
    const { dataRoot } = fixture()
    atomicWriteJson(dataRoot, 'index/character-directories.json', { schemaVersion: 1, characters: [{ id: 'char-1', directory: '../outside', chats: [] }] })
    await expect(list(dataRoot)).rejects.toThrow(/Unsafe/)
})
