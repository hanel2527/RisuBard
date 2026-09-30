import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { completeMemoryWorkspaceFork } from './risubard-memory-fork'
import {
    createMemorySaveSlot,
    deleteMemorySaveSlot,
    listAllMemorySaveSlots,
    listMemorySaveSlots,
    readMemorySaveChat,
    readMemorySaveReference,
    renameMemorySaveSlot,
    prepareMemorySaveLoad,
    writeMemorySaveReference,
} from './risubard-memory-save'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'

const roots: string[] = []

async function createRoot() {
    const root = await fs.mkdtemp(join(tmpdir(), 'risubard-save-slot-'))
    roots.push(root)
    return root
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
        fs.rm(root, { recursive: true, force: true })
    ))
})

describe('memory save slots', () => {
    async function overwriteFixture() {
        const root = await createRoot()
        const input = {
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'chat-source', saveId: 'save-1',
            sourceChatName: '모험', turnCount: 1, chatBytes: Buffer.from('old'),
            createdAt: '2026-08-14T08:00:00.000Z',
        }
        const source = resolveMemoryWorkspace(root, 'character', 'chat-source')
        const scene = join(source.directory, 'wiki', 'current-scene.md')
        await fs.mkdir(dirname(scene), { recursive: true })
        await fs.writeFile(scene, 'old wiki')
        const saved = await createMemorySaveSlot(input)
        await fs.writeFile(scene, 'new wiki')
        return { input, saved, source }
    }

    test('overwrites one slot with new chat and wiki while preserving its renamed label', async () => {
        const { input } = await overwriteFixture()
        await renameMemorySaveSlot({ ...input, name: '보스전 직전' })
        const saved = await createMemorySaveSlot({
            ...input, overwrite: true, chatBytes: Buffer.from('new'),
            turnCount: 9, latestMessageId: 'message-9',
            createdAt: '2026-08-15T08:00:00.000Z',
        })
        expect(saved).toMatchObject({
            saveId: input.saveId, sourceChatName: '보스전 직전',
            turnCount: 9, latestMessageId: 'message-9',
            createdAt: '2026-08-15T08:00:00.000Z',
        })
        expect(await listMemorySaveSlots(input)).toEqual([saved])
        expect(await readMemorySaveChat(input)).toEqual(Buffer.from('new'))
        const prepared = await prepareMemorySaveLoad({
            ...input, destinationChatId: 'loaded',
        })
        await completeMemoryWorkspaceFork({
            ...input, destinationChatId: 'loaded',
            forkToken: prepared.fork.forkToken, action: 'finalize',
        })
        const loaded = resolveMemoryWorkspace(input.userDataDirectory, 'character', 'loaded')
        expect(await fs.readFile(join(loaded.directory, 'wiki', 'current-scene.md'), 'utf8'))
            .toBe('new wiki')
        expect(prepared.chatBytes).toEqual(Buffer.from('new'))
    })

    test('requires explicit overwrite of an existing slot belonging to the current chat', async () => {
        const { input, saved } = await overwriteFixture()
        await expect(createMemorySaveSlot(input)).rejects.toThrow('already exists')
        await expect(createMemorySaveSlot({
            ...input, saveId: 'missing', overwrite: true,
        })).rejects.toThrow()
        await expect(createMemorySaveSlot({
            ...input, sourceChatId: 'other-chat', overwrite: true,
        })).rejects.toThrow('different chat')
        expect(await listMemorySaveSlots(input)).toEqual([saved])
        expect(await readMemorySaveChat(input)).toEqual(Buffer.from('old'))
    })

    test('atomically overwrites a reference slot as a v1 save without losing ownership', async () => {
        const root = await createRoot()
        const input = {
            userDataDirectory: root,
            characterId: 'character',
            sourceChatId: 'chat-source',
            saveId: 'save-reference',
            sourceChatName: 'Current chat name',
            turnCount: 3,
            chatBytes: Buffer.from('new chat state'),
        }
        const source = resolveMemoryWorkspace(root, 'character', 'chat-source')
        const scene = join(source.directory, 'wiki', 'current-scene.md')
        await fs.mkdir(dirname(scene), { recursive: true })
        await fs.writeFile(scene, 'current wiki')
        await writeMemorySaveReference({
            userDataDirectory: root,
            characterId: input.characterId,
            sourceChatId: input.sourceChatId,
            saveId: input.saveId,
            sourceChatName: 'Renamed saved story',
            turnCount: 2,
            chatStateRef: 'chat-state-hash',
        })

        await expect(createMemorySaveSlot({
            ...input,
            sourceChatId: 'another-chat',
            overwrite: true,
        })).rejects.toThrow('different chat')
        expect(await readMemorySaveReference({
            userDataDirectory: root,
            characterId: input.characterId,
            saveId: input.saveId,
        })).not.toBeNull()

        const saved = await createMemorySaveSlot({ ...input, overwrite: true })
        expect(saved.sourceChatName).toBe('Renamed saved story')
        expect(await readMemorySaveReference({
            userDataDirectory: root,
            characterId: input.characterId,
            saveId: input.saveId,
        })).toBeNull()
        expect(await listAllMemorySaveSlots({
            userDataDirectory: root,
            characterId: input.characterId,
            sourceChatId: input.sourceChatId,
        })).toEqual([{ ...saved, saveFormat: 'v1-snapshot' }])
        expect(await readMemorySaveChat(input)).toEqual(input.chatBytes)
        const prepared = await prepareMemorySaveLoad({
            ...input,
            destinationChatId: 'loaded-reference-save',
        })
        expect(prepared.chatBytes).toEqual(input.chatBytes)
        await completeMemoryWorkspaceFork({
            ...input,
            destinationChatId: 'loaded-reference-save',
            forkToken: prepared.fork.forkToken,
            action: 'finalize',
        })
    })

    test.each(['chat.bin', 'risubard-save.json', 'publish'])(
        'keeps the original slot and cleans staging when overwrite fails at %s', async (failure) => {
            const { input, saved, source } = await overwriteFixture()
            const fileSystem = {
                ...fs,
                writeFile: (async (path, ...args) => {
                    if (String(path).includes('.replace-') && String(path).endsWith(failure)) {
                        throw new Error('injected overwrite failure')
                    }
                    return fs.writeFile(path, ...args)
                }) as typeof fs.writeFile,
                rename: (async (from, to) => {
                    if (failure === 'publish' && String(from).includes('.replace-')) {
                        throw new Error('injected overwrite failure')
                    }
                    return fs.rename(from, to)
                }) as typeof fs.rename,
            }
            await expect(createMemorySaveSlot({
                ...input, overwrite: true, chatBytes: Buffer.from('new'),
            }, { fileSystem })).rejects.toThrow('injected overwrite failure')
            expect(await readMemorySaveChat(input)).toEqual(Buffer.from('old'))
            expect(await listMemorySaveSlots(input)).toEqual([saved])
            const slot = resolveMemoryWorkspace(input.userDataDirectory, 'character', 'save-slot:save-1')
            expect(await fs.readFile(join(slot.directory, 'wiki', 'current-scene.md'), 'utf8'))
                .toBe('old wiki')
            const entries = await fs.readdir(dirname(source.directory))
            expect(entries.filter((entry) => /\.(replace|restore)-/.test(entry))).toEqual([])
        }
    )

    test('stores chat bytes and a complete immutable wiki snapshot', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'character', 'chat-source')
        const scene = join(source.directory, 'wiki', 'current-scene.md')
        await fs.mkdir(dirname(scene), { recursive: true })
        await fs.writeFile(scene, '# 현재 장면\n\n성문 앞이다.', 'utf8')
        for (const internal of ['.risubard-snapshots', '.risubard-recovery']) {
            await fs.mkdir(join(source.directory, 'wiki', internal), {
                recursive: true,
            })
            await fs.writeFile(join(source.directory, 'wiki', internal, 'x'), 'x')
        }

        const saved = await createMemorySaveSlot({
            userDataDirectory: root,
            characterId: 'character',
            sourceChatId: 'chat-source',
            saveId: 'save-1',
            sourceChatName: '성문 앞',
            turnCount: 12,
            chatBytes: Buffer.from([1, 2, 3, 4]),
            createdAt: '2026-08-14T08:00:00.000Z',
            latestEvent: {
                title: '성문이 열렸다',
                excerpt: '경비병이 일행을 성 안으로 들였다.',
            },
        })

        expect(saved).toMatchObject({
            saveId: 'save-1', sourceChatId: 'chat-source',
            sourceChatName: '성문 앞', turnCount: 12,
            createdAt: '2026-08-14T08:00:00.000Z',
            latestEvent: { title: '성문이 열렸다' },
        })
        const savedWorkspace = resolveMemoryWorkspace(
            root, 'character', 'save-slot:save-1'
        )
        for (const internal of ['.risubard-snapshots', '.risubard-recovery']) {
            await expect(fs.access(join(
                savedWorkspace.directory, 'wiki', internal
            ))).rejects.toMatchObject({ code: 'ENOENT' })
        }
        expect(await listMemorySaveSlots({
            userDataDirectory: root,
            characterId: 'character',
            sourceChatId: 'chat-source',
        })).toEqual([saved])

        const prepared = await prepareMemorySaveLoad({
            userDataDirectory: root,
            characterId: 'character',
            saveId: 'save-1',
            destinationChatId: 'chat-loaded',
        })
        expect(prepared.chatBytes).toEqual(Buffer.from([1, 2, 3, 4]))
        expect(prepared.fork.destinationChatId).toBe('chat-loaded')
        const destination = resolveMemoryWorkspace(
            root, 'character', 'chat-loaded'
        )
        await expect(fs.stat(destination.directory))
            .rejects.toMatchObject({ code: 'ENOENT' })
        await completeMemoryWorkspaceFork({
            userDataDirectory: root,
            characterId: 'character',
            destinationChatId: 'chat-loaded',
            forkToken: prepared.fork.forkToken,
            action: 'finalize',
        })
        await expect(fs.readFile(
            join(destination.directory, 'wiki', 'current-scene.md'),
            'utf8'
        )).resolves.toContain('성문 앞이다.')
        await expect(fs.stat(join(destination.directory, 'chat.bin')))
            .rejects.toMatchObject({ code: 'ENOENT' })
        await expect(fs.stat(join(
            destination.directory, 'risubard-save.json'
        ))).rejects.toMatchObject({ code: 'ENOENT' })

        await completeMemoryWorkspaceFork({
            userDataDirectory: root,
            characterId: 'character',
            destinationChatId: 'chat-loaded',
            forkToken: prepared.fork.forkToken,
            action: 'finalize',
        })
    })

    test('replaces an existing current-chat wiki and restores it on discard', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'character', 'chat-source')
        const current = resolveMemoryWorkspace(root, 'character', 'chat-current')
        const sourceScene = join(source.directory, 'wiki', 'current-scene.md')
        const currentScene = join(current.directory, 'wiki', 'current-scene.md')
        await fs.mkdir(dirname(sourceScene), { recursive: true })
        await fs.mkdir(dirname(currentScene), { recursive: true })
        await fs.writeFile(sourceScene, '# 저장 장면\n', 'utf8')
        await fs.writeFile(currentScene, '# 현재 장면\n', 'utf8')
        await createMemorySaveSlot({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'chat-source', saveId: 'save-replace',
            sourceChatName: '저장본', turnCount: 1,
            chatBytes: Buffer.from([1]),
        })

        const prepared = await prepareMemorySaveLoad({
            userDataDirectory: root, characterId: 'character',
            saveId: 'save-replace', destinationChatId: 'chat-current',
        })
        await expect(fs.readFile(currentScene, 'utf8')).resolves.toContain('현재 장면')
        await completeMemoryWorkspaceFork({
            userDataDirectory: root, characterId: 'character',
            destinationChatId: 'chat-current',
            forkToken: prepared.fork.forkToken, action: 'discard',
        })
        await expect(fs.readFile(currentScene, 'utf8')).resolves.toContain('현재 장면')

        const finalized = await prepareMemorySaveLoad({
            userDataDirectory: root, characterId: 'character',
            saveId: 'save-replace', destinationChatId: 'chat-current',
        })
        await completeMemoryWorkspaceFork({
            userDataDirectory: root, characterId: 'character',
            destinationChatId: 'chat-current',
            forkToken: finalized.fork.forkToken, action: 'finalize',
        })
        await expect(fs.readFile(currentScene, 'utf8')).resolves.toContain('저장 장면')
        await expect(completeMemoryWorkspaceFork({
            userDataDirectory: root, characterId: 'character',
            destinationChatId: 'chat-current',
            forkToken: finalized.fork.forkToken, action: 'finalize',
        })).resolves.toEqual({ action: 'finalize', completed: true })
    })

    test('lists complete slots newest first and ignores incomplete directories', async () => {
        const root = await createRoot()
        for (const [saveId, createdAt, sourceChatId] of [
            ['older', '2026-08-14T07:00:00.000Z', 'source'],
            ['newer', '2026-08-14T09:00:00.000Z', 'source'],
            ['other-chat', '2026-08-14T10:00:00.000Z', 'other'],
        ] as const) {
            await createMemorySaveSlot({
                userDataDirectory: root,
                characterId: 'character',
                sourceChatId,
                saveId,
                sourceChatName: '모험',
                turnCount: 1,
                chatBytes: Buffer.from(saveId),
                createdAt,
            })
        }
        const incomplete = resolveMemoryWorkspace(
            root, 'character', 'save-slot:incomplete'
        )
        await fs.mkdir(incomplete.directory, { recursive: true })

        const slots = await listMemorySaveSlots({
            userDataDirectory: root,
            characterId: 'character',
            sourceChatId: 'source',
        })
        expect(slots.map((slot) => slot.saveId)).toEqual(['newer', 'older'])
    })

    test('does not probe ordinary chat workspaces while listing save slots', async () => {
        const root = await createRoot()
        const ordinaryDirectories: string[] = []
        for (let index = 0; index < 24; index += 1) {
            const workspace = resolveMemoryWorkspace(
                root, 'character', `ordinary-chat-${index}`
            )
            ordinaryDirectories.push(workspace.directory)
            await fs.mkdir(workspace.directory, { recursive: true })
        }
        await createMemorySaveSlot({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', saveId: 'save-1',
            sourceChatName: '모험', turnCount: 1,
            chatBytes: Buffer.from('saved'),
        })

        const probedPaths: string[] = []
        const fileSystem = {
            lstat: async (path: Parameters<typeof fs.lstat>[0]) => {
                probedPaths.push(String(path))
                return fs.lstat(path)
            },
            mkdir: fs.mkdir,
            readdir: fs.readdir,
            readFile: fs.readFile,
            rm: fs.rm,
            writeFile: fs.writeFile,
            copyFile: fs.copyFile,
            rename: fs.rename,
            realpath: fs.realpath,
        }

        await expect(listMemorySaveSlots({
            userDataDirectory: root,
            characterId: 'character',
            sourceChatId: 'source',
        }, { fileSystem })).resolves.toHaveLength(1)
        expect(probedPaths.some((path) => ordinaryDirectories.some(
            (directory) => path.startsWith(directory)
        ))).toBe(false)
    })

    test('reads, renames, and deletes one validated saved file', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'character', 'chat-source')
        await fs.mkdir(source.directory, { recursive: true })
        const bytes = Buffer.from([7, 8, 9])
        await createMemorySaveSlot({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'chat-source', saveId: 'save-1',
            sourceChatName: '원래 이름', turnCount: 2, chatBytes: bytes,
        })

        await expect(readMemorySaveChat({
            userDataDirectory: root, characterId: 'character', saveId: 'save-1',
        })).resolves.toEqual(bytes)
        await expect(renameMemorySaveSlot({
            userDataDirectory: root, characterId: 'character', saveId: 'save-1',
            name: '바뀐 이름',
        })).resolves.toMatchObject({ sourceChatName: '바뀐 이름' })
        await deleteMemorySaveSlot({
            userDataDirectory: root, characterId: 'character', saveId: 'save-1',
        })
        await expect(listMemorySaveSlots({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'chat-source',
        })).resolves.toEqual([])
    })
})
