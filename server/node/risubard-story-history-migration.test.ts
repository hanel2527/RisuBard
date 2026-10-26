import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Packr, Unpackr } from 'msgpackr'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createStoryHistoryService } from './risubard-story-history'
import { createStoryHistoryMigration } from './risubard-story-history-migration'
import { createMemorySaveSlot, listMemorySaveSlots, readMemorySaveChat, prepareMemorySaveLoad } from './risubard-memory-save'
import { completeMemoryWorkspaceFork } from './risubard-memory-fork'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return { ...actual, statfs: vi.fn(actual.statfs) }
})
const roots: string[] = []
const packer = new Packr({ useRecords: false })
const unpacker = new Unpackr({ int64AsType: 'number', useRecords: false })
const identity = { characterId: 'character', chatId: 'chat' }

async function fixture() {
    const root = await fs.mkdtemp(join(tmpdir(), 'risubard-history-migration-'))
    roots.push(root)
    const wiki = join(resolveMemoryWorkspace(root, identity.characterId, identity.chatId).directory, 'wiki')
    await fs.mkdir(wiki, { recursive: true })
    await fs.writeFile(join(wiki, 'scene.md'), '# Before\nThe door is closed.')
    const chat = { id: identity.chatId, name: 'Story', note: '', localLore: [], scriptstate: { keys: 1 }, message: [
        { chatId: 'u1', role: 'user', data: 'Open the door' },
        { chatId: 'a1', role: 'char', data: 'It opens', risubardMemoryConfirmed: true },
    ] }
    await createMemorySaveSlot({ userDataDirectory: root, characterId: identity.characterId,
        sourceChatId: identity.chatId, saveId: 'old-slot', sourceChatName: chat.name,
        turnCount: 1, chatBytes: packer.pack(chat), createdAt: '2026-10-01T00:00:00.000Z' })
    await fs.writeFile(join(wiki, 'scene.md'), '# Current\nThe door is open.')
    const history = createStoryHistoryService(root)
    const migration = createStoryHistoryMigration(root, history)
    return { root, wiki, chat, history, migration }
}

afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('story history migration and legacy rollback', () => {
    test('dry-run leaves legacy mode and original save bytes untouched', async () => {
        const { root, chat, history, migration } = await fixture()
        const before = await readMemorySaveChat({ userDataDirectory: root, characterId: identity.characterId, saveId: 'old-slot' })
        const result = await migration.migrate({ ...identity, chat, operationId: 'dry', dryRun: true })
        expect(result.report.legacySlots).toBe(1)
        expect((await history.status(identity)).mode).toBe('legacy')
        expect(await readMemorySaveChat({ userDataDirectory: root, characterId: identity.characterId, saveId: 'old-slot' })).toEqual(before)
        await expect(fs.access(join(root, result.report.archivePath))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    test('imports independent legacy roots and preserves edited and unedited snapshots through rollback', async () => {
        const { root, wiki, chat, history, migration } = await fixture()
        const migrated = await migration.migrate({ ...identity, chat, operationId: 'migrate' })
        expect(migrated.state.mode).toBe('history')
        expect(migrated.state.bindings).toEqual({})
        expect(migrated.state.backups.filter(backup => backup.parentId === null)).toHaveLength(2)
        const edited = await history.capture({ ...identity, operationId: 'edit', kind: 'chat-edit', delta: {
            baseSnapshotId: migrated.state.workingSnapshotId,
            order: ['u1', 'a1'], messages: [{ id: 'u1', value: { ...chat.message[0], data: 'Unlock the door' } }],
            state: { id: chat.id, name: chat.name, note: chat.note, localLore: chat.localLore, scriptstate: chat.scriptstate },
        } })
        expect(edited.bindings).toEqual(migrated.state.bindings)
        expect(edited.wikiCommitId).toBe(migrated.state.wikiCommitId)
        const all = await history.exportHistory(identity)
        const rollback = await migration.rollback({ ...identity, operationId: 'rollback' })
        expect(rollback.state.mode).toBe('legacy')
        const slots = await listMemorySaveSlots({ userDataDirectory: root, characterId: identity.characterId, sourceChatId: identity.chatId })
        const exported = slots.filter(slot => slot.saveId.startsWith('history-'))
        expect(exported).toHaveLength(all.backups.length)
        const chats = await Promise.all(exported.map(async slot => unpacker.unpack(await readMemorySaveChat({
            userDataDirectory: root, characterId: identity.characterId, saveId: slot.saveId,
        }))))
        expect(chats.some(value => value.message[0].data === 'Unlock the door')).toBe(true)
        expect(chats.some(value => value.message[0].data === 'Open the door')).toBe(true)
        expect(chats.every(value => value.message[1].data === 'It opens' && value.scriptstate.keys === 1)).toBe(true)
        expect(await fs.readFile(join(wiki, 'scene.md'), 'utf8')).toContain('The door is open.')
        const archive = JSON.parse(await fs.readFile(join(root, rollback.report.archivePath, 'history-archive.json'), 'utf8'))
        const oldEntry = all.backups.find(item => item.backup.name === 'Story' && item.chat.message)!
        const mapped = archive.mapping.find((item: { backupId: string }) => item.backupId === oldEntry.backup.id)
        const prepared = await prepareMemorySaveLoad({ userDataDirectory: root, characterId: identity.characterId,
            saveId: mapped.saveId, destinationChatId: 'loaded' })
        await completeMemoryWorkspaceFork({ userDataDirectory: root, characterId: identity.characterId,
            destinationChatId: 'loaded', forkToken: prepared.fork.forkToken, action: 'finalize' })
        expect(unpacker.unpack(prepared.chatBytes)).toEqual(oldEntry.chat)
        const restoredWiki = join(resolveMemoryWorkspace(root, identity.characterId, 'loaded').directory, 'wiki', 'scene.md')
        expect(await fs.readFile(restoredWiki, 'utf8')).toBe('# Before\nThe door is closed.')
        const remigrated = await migration.migrate({ ...identity, chat: rollback.chat!, operationId: 'remigrate' })
        const originalIds = new Set(all.backups.map(item => item.backup.id))
        expect(remigrated.state.backups.filter(backup => originalIds.has(backup.id))).toHaveLength(originalIds.size)
        for (const original of all.backups) {
            expect(remigrated.state.backups.find(backup => backup.id === original.backup.id)?.parentId)
                .toBe(original.backup.parentId)
        }
    })

    test('does not switch to legacy when canonical persistence fails and safely resumes', async () => {
        const { root, chat, history, migration } = await fixture()
        await migration.migrate({ ...identity, chat, operationId: 'migrate' })
        const failing = createStoryHistoryMigration(root, history, {
            persistChat: async () => { throw new Error('disk unavailable') },
        })
        await expect(failing.rollback({ ...identity, operationId: 'retryable-rollback' })).rejects.toThrow('disk unavailable')
        expect((await history.status(identity)).mode).toBe('history')
        const first = await migration.rollback({ ...identity, operationId: 'retryable-rollback' })
        const repeated = await migration.rollback({ ...identity, operationId: 'retryable-rollback' })
        expect(first.state.mode).toBe('legacy')
        expect(repeated.report).toEqual(first.report)
        const slots = await listMemorySaveSlots({ userDataDirectory: root, characterId: identity.characterId, sourceChatId: identity.chatId })
        expect(slots.filter(slot => slot.saveId.startsWith('history-'))).toHaveLength(first.report.backups)
    })

    test('imports v1 workspace files and legacy messages without IDs without changing original bytes', async () => {
        const { root, chat, history, migration } = await fixture()
        const directory = resolveMemoryWorkspace(root, identity.characterId, 'save-slot:old-v1').directory
        await fs.mkdir(join(directory, 'wiki'), { recursive: true })
        const oldChat = { ...chat, message: [{ role: 'char', data: 'Before IDs existed', optional: undefined }] }
        const bytes = packer.pack(oldChat)
        await fs.writeFile(join(directory, 'chat.bin'), bytes)
        await fs.writeFile(join(directory, 'wiki', 'scene.md'), '# Legacy v1')
        await fs.writeFile(join(directory, 'risubard-save.json'), JSON.stringify({
            schemaVersion: 1, saveId: 'old-v1', sourceChatId: identity.chatId, sourceChatName: 'Old format',
            createdAt: '2026-09-01T00:00:00.000Z', turnCount: 1,
        }))
        await migration.migrate({ ...identity, chat, operationId: 'import-v1' })
        const exported = await history.exportHistory(identity)
        const old = exported.backups.find(item => item.backup.name === 'Old format')!
        expect(old.wikiFiles.map(file => file.path)).toEqual(['wiki/scene.md'])
        expect(old.chat.message).toEqual([{ role: 'char', data: 'Before IDs existed', chatId: expect.stringMatching(/^import-/) }])
        expect(await fs.readFile(join(directory, 'chat.bin'))).toEqual(bytes)
    })

    test('refuses an undersized volume before copying v1 or current wiki data', async () => {
        const { root, chat, history, migration } = await fixture()
        const directory = resolveMemoryWorkspace(root, identity.characterId, 'save-slot:capacity-v1').directory
        await fs.mkdir(join(directory, 'wiki'), { recursive: true })
        await fs.writeFile(join(directory, 'wiki', 'new.md'), 'uncached v1 wiki contents')
        await fs.writeFile(join(directory, 'chat.bin'), packer.pack(chat))
        await fs.writeFile(join(directory, 'risubard-save.json'), JSON.stringify({
            schemaVersion: 1, saveId: 'capacity-v1', sourceChatId: identity.chatId,
            sourceChatName: 'Capacity', createdAt: '2026-09-01T00:00:00.000Z', turnCount: 1,
        }))
        const before = (await fs.readdir(root, { recursive: true })).sort()
        vi.mocked(fs.statfs).mockResolvedValueOnce({ bavail: 0, bsize: 4096 } as Awaited<ReturnType<typeof fs.statfs>>)
        await expect(migration.migrate({ ...identity, chat, operationId: 'capacity' }))
            .rejects.toThrow('Not enough disk space')
        expect((await history.status(identity)).mode).toBe('legacy')
        expect((await fs.readdir(root, { recursive: true })).sort()).toEqual(before)
    })

    test('rejects malformed chat content rather than inventing a recoverable history', async () => {
        const { root, chat, history, migration } = await fixture()
        await createMemorySaveSlot({ userDataDirectory: root, characterId: identity.characterId,
            sourceChatId: identity.chatId, saveId: 'bad-slot', sourceChatName: 'Bad', turnCount: 1,
            chatBytes: packer.pack({ name: 'Bad', message: [{ role: 'char', data: 42 }] }) })
        await expect(migration.migrate({ ...identity, chat, operationId: 'malformed' })).rejects.toThrow('invalid message')
        expect((await history.status(identity)).mode).toBe('legacy')
        expect(await readMemorySaveChat({ userDataDirectory: root, characterId: identity.characterId, saveId: 'old-slot' }))
            .toEqual(packer.pack(chat))
    })
})
