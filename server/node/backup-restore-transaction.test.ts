import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { createFileKv } = require('./file-kv.cjs')
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { publishBackupRestore } = require('./backup-restore-transaction.cjs')

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))
function tempRoot() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-restore-')); roots.push(root); return root }

it('publishes KV, canonical files and inlays as one recoverable restore generation', async () => {
    const dataRoot = tempRoot()
    const store = createFileKv({ dataRoot })
    store.kvSet('assets/old', Buffer.from('old-asset'))
    const repository = createUserDataRepository({ dataRoot, allowDirectoryMapping: true })
    repository.importLegacyDatabase({ characters: [{ chaId: 'old', name: 'Old', chats: [] }] })
    const mapping = repository.publishCharacterDirectoryMapping('old')
    expect(mapping.directory).not.toBe('old')
    fs.mkdirSync(path.join(dataRoot, 'inlays'), { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'inlays/old.png'), 'old-inlay')

    const entryStaging = path.join(dataRoot, '.entry-staging')
    const canonicalStaging = path.join(dataRoot, '.canonical-staging')
    const inlayStaging = path.join(dataRoot, '.inlay-staging')
    fs.mkdirSync(entryStaging)
    fs.mkdirSync(path.join(canonicalStaging, 'characters/new'), { recursive: true })
    fs.mkdirSync(path.join(canonicalStaging, 'index'), { recursive: true })
    fs.mkdirSync(inlayStaging)
    fs.writeFileSync(path.join(entryStaging, 'asset.bin'), 'new-asset')
    fs.writeFileSync(path.join(canonicalStaging, 'characters/new/metadata.json'), JSON.stringify({ chaId: 'new', name: 'New', chats: [] }))
    fs.writeFileSync(path.join(canonicalStaging, 'index/sidebar.json'), JSON.stringify({ schemaVersion: 1, characters: [{ id: 'new', name: 'New', chats: [] }] }))
    fs.writeFileSync(path.join(inlayStaging, 'new.png'), 'new-inlay')
    const prepared = await store.preparePrefixReplacementFromFilesAsync([
        { key: 'assets/new', sourcePath: path.join(entryStaging, 'asset.bin') },
    ], ['assets/'])

    await publishBackupRestore({
        dataRoot, canonicalStagingDir: canonicalStaging, inlayStagingDir: inlayStaging,
        canonicalDirectories: ['characters', 'index'], manifestBytes: prepared.manifestBytes,
        store, restoreId: 'restore-1',
    })

    expect(store.kvList('assets/')).toEqual(['assets/new'])
    expect(store.kvGet('assets/new')?.toString()).toBe('new-asset')
    expect(repository.exportLegacyDatabase().characters.map((character: any) => character.chaId)).toEqual(['new'])
    expect(fs.readFileSync(path.join(dataRoot, 'inlays/new.png'), 'utf8')).toBe('new-inlay')
    expect(fs.existsSync(path.join(dataRoot, 'inlays/old.png'))).toBe(false)
    expect(fs.readFileSync(path.join(dataRoot, 'trash/restore-1/characters', mapping.directory, 'metadata.json'), 'utf8')).toContain('Old')
    expect(fs.readFileSync(path.join(dataRoot, 'trash/restore-1/characters/old/metadata.json'), 'utf8')).toContain('Old')
    expect(fs.readFileSync(path.join(dataRoot, 'trash/restore-1/inlays/old.png'), 'utf8')).toBe('old-inlay')
})

it('finishes a partially published restore before reporting the injected failure', async () => {
    const dataRoot = tempRoot()
    const store = createFileKv({ dataRoot })
    store.kvSet('assets/old', Buffer.from('old'))
    fs.mkdirSync(path.join(dataRoot, 'settings'), { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'settings/old.json'), 'old')
    const canonicalStaging = path.join(dataRoot, '.canonical-staging')
    const inlayStaging = path.join(dataRoot, '.inlay-staging')
    const entryStaging = path.join(dataRoot, '.entry-staging')
    fs.mkdirSync(path.join(canonicalStaging, 'settings'), { recursive: true })
    fs.mkdirSync(inlayStaging)
    fs.mkdirSync(entryStaging)
    fs.writeFileSync(path.join(canonicalStaging, 'settings/new.json'), 'new')
    fs.writeFileSync(path.join(entryStaging, 'asset.bin'), 'new')
    const prepared = await store.preparePrefixReplacementFromFilesAsync([
        { key: 'assets/new', sourcePath: path.join(entryStaging, 'asset.bin') },
    ], ['assets/'])

    await expect(publishBackupRestore({
        dataRoot, canonicalStagingDir: canonicalStaging, inlayStagingDir: inlayStaging,
        canonicalDirectories: ['settings'], manifestBytes: prepared.manifestBytes,
        store, restoreId: 'restore-2', transactionOptions: { failAfterPublish: 1 },
    })).rejects.toThrow(/simulated crash/)

    expect(fs.readFileSync(path.join(dataRoot, 'settings/new.json'), 'utf8')).toBe('new')
    expect(store.kvList('assets/')).toEqual(['assets/new'])
    expect(fs.readdirSync(path.join(dataRoot, '.journal'))).toEqual([])
})
