import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { atomicWriteJson } = require('./file-store.cjs')
const { DIRECTORY_INDEX, createCharacterDirectoryResolver } = require('./character-directories.cjs')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))
function fixture() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-mapping-'))
    roots.push(dataRoot)
    const repo = createUserDataRepository({ dataRoot, allowDirectoryMapping: true })
    repo.importLegacyDatabase({ characters: [{ chaId: 'char-1', name: 'Alice', chats: [{ id: 'chat-1', name: 'First chat', message: [{ role: 'user', data: 'hello' }] }] }] })
    return { dataRoot, repo }
}
it('publishes an explicit mapping, preserves old folders, and routes restart, writes and deletion by stable IDs', () => {
    const { dataRoot, repo } = fixture()
    repo.saveAssistantDraft('char-1', 'chat-1', { role: 'char', data: 'draft' })
    const before = repo.exportLegacyDatabase()
    const mapping = repo.publishCharacterDirectoryMapping('char-1')
    expect(mapping.directory).toBe('Alice')
    expect(mapping.chats[0].directory).toBe('First chat')
    expect(repo.exportLegacyDatabase()).toEqual(before)
    const reopened = createUserDataRepository({ dataRoot })
    expect(reopened.loadAssistantDraft('char-1', 'chat-1').data).toBe('draft')
    reopened.finalizeAssistantDraft('char-1', 'chat-1')
    expect(reopened.loadMessages('char-1', 'chat-1')).toHaveLength(2)
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'characters/char-1/chats/chat-1/draft.json'), 'utf8')).data).toBe('draft')
    const updated = reopened.exportLegacyDatabase()
    updated.characters[0].name = 'Renamed'
    updated.characters[0].chats[0].name = 'Renamed chat'
    reopened.importLegacyDatabase(updated)
    expect(reopened.loadCharacter('char-1').name).toBe('Renamed')
    expect(fs.existsSync(path.join(dataRoot, 'characters/Renamed'))).toBe(false)
    expect(reopened.reconcileCanonicalProjection().database.characters).toHaveLength(1)
    reopened.importLegacyDatabase({ characters: [] }, { mode: 'replace' })
    expect(createUserDataRepository({ dataRoot }).exportLegacyDatabase().characters).toEqual([])
    expect(fs.existsSync(path.join(dataRoot, 'characters/char-1'))).toBe(true)
    expect(fs.existsSync(path.join(dataRoot, 'characters/Alice'))).toBe(false)
})
it('requires explicit internal opt-in and allocates case-insensitive collision-free paths', () => {
    const { dataRoot, repo } = fixture()
    expect(() => createUserDataRepository({ dataRoot }).publishCharacterDirectoryMapping('char-1')).toThrow(/disabled/)
    fs.mkdirSync(path.join(dataRoot, 'characters/ALICE'))
    const mapped = repo.publishCharacterDirectoryMapping('char-1')
    expect(mapped.directory).toBe('Alice (2)')
    expect(() => repo.publishCharacterDirectoryMapping('char-1')).toThrow(/already/)
})

it('routes direct chat saves, new imports, revisions and chat trash while excluding retained copies', () => {
    const { dataRoot, repo } = fixture()
    repo.publishCharacterDirectoryMapping('char-1')
    const revision = repo.getProjectionRevision()
    const updated = repo.exportLegacyDatabase()
    updated.characters[0].chats[0].message.push({ role: 'char', data: 'new' })
    repo.syncLegacyChatState(updated, { chats: [{ characterId: 'char-1', chatId: 'chat-1' }] })
    expect(repo.getProjectionRevision()).not.toBe(revision)
    expect(repo.loadIndexedChat('char-1', 0).message).toHaveLength(2)
    expect(repo.loadStartupDatabase().characters[0].chats[0]._stub).toBe(true)
    repo.importLegacyDatabase({ characters: [{ chaId: 'char-1', name: 'Alice', chats: [{ id: 'chat-2', name: 'New', message: [] }] }, { chaId: 'char-2', name: 'Bob', chats: [] }] }, { mode: 'replace' })
    expect(fs.existsSync(path.join(dataRoot, 'characters/Alice/chats/First chat'))).toBe(false)
    const reopened = createUserDataRepository({ dataRoot })
    expect(reopened.exportLegacyDatabase().characters.map(c => c.chaId)).toEqual(['char-1', 'char-2'])
    expect(reopened.exportLegacyDatabase().characters[0].chats.map(c => c.id)).toEqual(['chat-2'])
    expect(fs.existsSync(path.join(dataRoot, 'characters/Alice/chats/chat-2'))).toBe(true)
})

it('rejects new IDs reserved by mapped directory names without changing current files', () => {
    const { repo } = fixture()
    repo.publishCharacterDirectoryMapping('char-1')
    const before = repo.exportLegacyDatabase()
    expect(() => repo.importLegacyDatabase({ characters: [{ chaId: 'ALICE', chats: [] }] })).toThrow(/collides/)
    expect(repo.exportLegacyDatabase()).toEqual(before)
})

it.each(['../escape', 'CON', 'trailing.', '.hidden', 'a/b', 'a\\b'])('rejects unsafe mapping directory %s', directory => {
    const { dataRoot } = fixture()
    atomicWriteJson(dataRoot, DIRECTORY_INDEX, { schemaVersion: 1, characters: [{ id: 'char-1', directory, chats: [] }] })
    expect(() => createUserDataRepository({ dataRoot })).toThrow(/Unsafe/)
})

it('fails closed for missing or corrupt mapping and never uses an older backup', () => {
    const { dataRoot, repo } = fixture()
    repo.publishCharacterDirectoryMapping('char-1')
    fs.writeFileSync(path.join(dataRoot, `${DIRECTORY_INDEX}.bak`), JSON.stringify({ schemaVersion: 1, characters: [] }))
    const bytes = fs.readFileSync(path.join(dataRoot, DIRECTORY_INDEX))
    fs.writeFileSync(path.join(dataRoot, DIRECTORY_INDEX), '{}')
    expect(() => repo.getProjectionRevision()).toThrow()
    fs.writeFileSync(path.join(dataRoot, DIRECTORY_INDEX), bytes)
    expect(repo.loadCharacter('char-1').name).toBe('Alice')
    fs.unlinkSync(path.join(dataRoot, DIRECTORY_INDEX))
    expect(() => repo.getProjectionRevision()).toThrow(/missing/)
    expect(() => createUserDataRepository({ dataRoot })).toThrow(/missing/)
})

it('recovers journal publication interrupted before the mapping is published', () => {
    const { dataRoot } = fixture()
    const repo = createUserDataRepository({ dataRoot, allowDirectoryMapping: true })
    const before = repo.exportLegacyDatabase()
    const rename = fs.renameSync
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(to) === path.join(dataRoot, DIRECTORY_INDEX)) throw new Error('Simulated mapping interruption')
        return rename(from, to)
    })
    try { expect(() => repo.publishCharacterDirectoryMapping('char-1')).toThrow(/interruption/) }
    finally { spy.mockRestore() }
    expect(fs.existsSync(path.join(dataRoot, DIRECTORY_INDEX))).toBe(false)
    const reopened = createUserDataRepository({ dataRoot })
    expect(reopened.exportLegacyDatabase()).toEqual(before)
    expect(reopened.reconcileCanonicalProjection().database.characters).toHaveLength(1)
    expect(fs.readdirSync(path.join(dataRoot, '.journal')).filter(name => name.endsWith('.json'))).toEqual([])
})

it('notifies other cached resolvers when a checked external mapping is published', () => {
    const { dataRoot } = fixture()
    const first = createCharacterDirectoryResolver(dataRoot)
    const second = createCharacterDirectoryResolver(dataRoot)
    atomicWriteJson(dataRoot, DIRECTORY_INDEX, { schemaVersion: 1, characters: [{ id: 'char-1', directory: 'Alice', chats: [] }] })
    first.refresh()
    expect(second.characterDirectory('char-1')).toBe(path.join('characters', 'Alice'))
})
