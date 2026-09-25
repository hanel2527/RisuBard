import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { createUserDataRepository } = require('./user-data-repository.cjs')
const roots: string[] = []
const character = (chaId: string, name = 'New character') => ({ chaId, name, chats: [{ id: 'chat-one', name: 'First chat', message: [{ role: 'user', data: 'hello' }] }] })
function setup() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'new-character-package-'))
    roots.push(dataRoot)
    return { dataRoot, repository: createUserDataRepository({ dataRoot, allowDirectoryMapping: true, newCharacterPackages: true }) }
}
afterEach(() => {
    vi.restoreAllMocks()
    roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }))
})

it('publishes new characters directly in friendly packages and survives restart', () => {
    const { dataRoot, repository } = setup()
    const database = { characters: [character('new-one'), character('new-two')] }
    repository.importLegacyDatabase(database, { mode: 'sync' })
    expect(repository.characterDirectoryStatus('new-one')).toMatchObject({ enabled: true, directory: 'New character' })
    expect(repository.characterDirectoryStatus('new-two')).toMatchObject({ enabled: true, directory: 'New character (2)' })
    expect(fs.existsSync(path.join(dataRoot, 'characters/new-one'))).toBe(false)
    expect(fs.existsSync(path.join(dataRoot, 'characters/New character/chats/First chat/messages.jsonl'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'characters/New character/package.json'), 'utf8')).characterId).toBe('new-one')
    expect(createUserDataRepository({ dataRoot }).exportLegacyDatabase().characters).toEqual(database.characters)
})

it('keeps existing IDs and replacement imports in their original layout', () => {
    const { repository } = setup()
    repository.importLegacyDatabase({ characters: [character('old')] }, { mode: 'replace' })
    repository.importLegacyDatabase({ characters: [character('old', 'Renamed'), character('new')] }, { mode: 'sync' })
    expect(repository.characterDirectoryStatus('old').enabled).toBe(false)
    expect(repository.characterDirectoryStatus('new').enabled).toBe(true)
    repository.importLegacyDatabase({ characters: [character('restored')] }, { mode: 'replace' })
    expect(repository.characterDirectoryStatus('restored').enabled).toBe(false)
})

it('can preserve legacy layout explicitly for bootstrap and backup restoration', () => {
    const { repository } = setup()
    repository.importLegacyDatabase({ characters: [character('restored')] }, { mode: 'sync', preserveCharacterLayout: true })
    expect(repository.characterDirectoryStatus('restored').enabled).toBe(false)
})

it('reserves incoming character and chat IDs while allocating friendly names', () => {
    const { repository } = setup()
    const first = character('one', 'two')
    first.chats.push({ id: 'other', name: 'chat-one', message: [] })
    repository.importLegacyDatabase({ characters: [first, character('two')] }, { mode: 'sync' })
    expect(repository.characterDirectoryStatus('one').directory).toBe('two (2)')
    expect(repository.exportLegacyDatabase().characters).toEqual([first, character('two')])
})

it('recovers a prepared package transaction interrupted before mapping publication', () => {
    const { dataRoot, repository } = setup()
    const rename = fs.renameSync
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (String(destination) === path.join(dataRoot, 'index/character-directories.json')) {
            throw new Error('injected publication failure')
        }
        return rename(source, destination)
    })
    const database = { characters: [character('new')] }
    expect(() => repository.importLegacyDatabase(database, { mode: 'sync' })).toThrow('injected publication failure')
    spy.mockRestore()
    const restarted = createUserDataRepository({ dataRoot })
    expect(restarted.characterDirectoryStatus('new').enabled).toBe(true)
    expect(restarted.exportLegacyDatabase().characters).toEqual(database.characters)
    expect(fs.existsSync(path.join(dataRoot, 'characters/new'))).toBe(false)
})
