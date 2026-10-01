import { createRequire } from 'node:module'
import { access, mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { Packr, Unpackr } from 'msgpackr'
import type { Chat } from '../../src/ts/storage/database.svelte'
import { createWikiVcsRepository, resolveWikiVcsRepository } from './risubard-wiki-vcs'
import { createMemoryAnalysisRunner } from './risubard-memory-analysis'
import { createNarrativeMemoryService } from './risubard-memory-service'
import { forkWikiVersion } from '../../src/ts/risubard/wikiVersionClient'
import { chatBoundaryAnchor } from '../../src/ts/risubard/wikiVcsContract'
import { prepareMemorySaveChatSnapshot } from '../../src/ts/risubard/memorySavePolicy'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import { resolveNarrativeGraphWorkspace } from './risubard-graph-workspace'
import { resolveMarkdownWikiWorkspace } from './risubard-markdown-wiki'

const require = createRequire(import.meta.url)

function seedCanonicalChat(root: string, chat: Chat = {
    id: 'chat-1', name: 'Story', note: '', localLore: [], fmIndex: -1,
    message: [{ chatId: 'm1', role: 'char', data: 'Aria is at the keep.' }],
}) {
    const { createUserDataRepository } = require('./user-data-repository.cjs')
    const canonical = createUserDataRepository({ dataRoot: root })
    canonical.importLegacyDatabase({ characters: [{ chaId: 'character', name: 'Aria', chats: [chat] }] })
    return { canonical, chat }
}

describe('RisuBard memory CommonJS runtime', () => {
    test('restores a v1 save at its pinned Wiki head after a runtime restart', async () => {
        const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
        const root = await mkdtemp(join(tmpdir(), 'risubard-runtime-save-restore-'))
        try {
            const { createUserDataRepository } = require('./user-data-repository.cjs')
            const canonical = createUserDataRepository({ dataRoot: root })
            const savedChat = {
                id: 'chat-1', name: 'Story', scriptstate: { score: 100 },
                message: [{ chatId: 'm1', role: 'char', data: 'Before the gate.' }],
            }
            canonical.importLegacyDatabase({ characters: [{ chaId: 'character', name: 'One', chats: [savedChat] }] })
            const packer = new Packr({ useRecords: false })
            let service = createRuntimeMemoryService(root, { canonicalRepository: canonical })
            const savedDocument = await service.saveManualWikiDocument({
                characterId: 'character', chatId: 'chat-1', type: 'concept',
                title: 'Clock', markdown: '# Clock\n\n## State\n\n- Before the gate.',
            })
            const savedHead = (await service.wikiHistory({
                characterId: 'character', chatId: 'chat-1',
            }))[0].commitId
            await service.createMemorySave({
                characterId: 'character', sourceChatId: 'chat-1',
                saveId: 'save-1', sourceChatName: 'Story', turnCount: 1,
                chatBytes: packer.pack(savedChat),
            })
            const futureChat = { ...savedChat, scriptstate: { score: 300 }, message: [
                ...savedChat.message, { chatId: 'm2', role: 'char', data: 'After the gate.' },
            ] }
            canonical.replaceChat('character', 'chat-1', savedChat, futureChat)
            await service.saveManualWikiDocument({
                characterId: 'character', chatId: 'chat-1', type: 'concept',
                documentId: savedDocument.id, title: 'Clock',
                markdown: '# Clock\n\n## State\n\n- After the gate.',
            })
            const prepared = await service.prepareMemorySaveLoad({
                characterId: 'character', saveId: 'save-1', destinationChatId: 'chat-1',
            })
            expect((await service.loadView('character', 'chat-1')).documents[0].content)
                .toContain('After the gate.')
            service = createRuntimeMemoryService(root, { canonicalRepository: canonical })
            await service.completeMemoryFork({
                characterId: 'character', destinationChatId: 'chat-1',
                forkToken: prepared.fork.forkToken, action: 'finalize',
                chatBase64: packer.pack(savedChat).toString('base64'),
            })
            expect((await service.wikiHistory({
                characterId: 'character', chatId: 'chat-1',
            }))[0].commitId).toBe(savedHead)
            expect((await service.loadView('character', 'chat-1')).documents[0].content)
                .toContain('Before the gate.')
            expect(canonical.loadChat('character', 'chat-1')).toEqual(savedChat)
            await service.deleteMemorySave({ characterId: 'character', saveId: 'save-1' })
            expect(await service.listMemorySaves({
                characterId: 'character', sourceChatId: 'chat-1',
            })).toEqual([])
        }

        finally { await rm(root, { recursive: true, force: true }) }
    })

    test('deletes and recreates a legacy save without resurrecting its slot as a chat', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const root = await mkdtemp(join(tmpdir(), 'risubard-runtime-legacy-save-'))
        try {
            const { canonical, chat } = seedCanonicalChat(root)
            const packer = new Packr({ useRecords: false })
            const service = createRuntimeMemoryService(root, { canonicalRepository: canonical })
            const saveInput = {
                characterId: 'character', sourceChatId: 'chat-1',
                saveId: 'legacy', sourceChatName: 'Story', turnCount: 1,
                chatBytes: packer.pack(chat),
            }
            await service.createMemorySave(saveInput)
            const saveDirectory = resolveMemoryWorkspace(
                root, 'character', 'save-slot:legacy'
            ).directory
            await rm(join(saveDirectory, 'risubard-save-vcs.json'))

            await service.deleteMemorySave({
                characterId: 'character', saveId: 'legacy',
            })
            await expect(access(saveDirectory)).rejects.toMatchObject({
                code: 'ENOENT',
            })

            const recreated = { ...chat, name: 'Recreated story' }
            canonical.replaceChat('character', 'chat-1', chat, recreated)
            await service.createMemorySave({
                ...saveInput, chatBytes: packer.pack(recreated),
            })
            expect(await service.listMemorySaves({
                characterId: 'character', sourceChatId: 'chat-1',
            })).toEqual([expect.objectContaining({
                saveId: 'legacy', sourceChatId: 'chat-1',
            })])
            await expect(access(saveDirectory)).resolves.toBeUndefined()
        }
        finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    test('does not delete a save whose legacy manifest is corrupt', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const root = await mkdtemp(join(tmpdir(), 'risubard-runtime-corrupt-save-'))
        try {
            const { canonical, chat } = seedCanonicalChat(root)
            const service = createRuntimeMemoryService(root, { canonicalRepository: canonical })
            await service.createMemorySave({
                characterId: 'character', sourceChatId: 'chat-1',
                saveId: 'legacy', sourceChatName: 'Story', turnCount: 1,
                chatBytes: new Packr({ useRecords: false }).pack(chat),
            })
            const saveDirectory = resolveMemoryWorkspace(
                root, 'character', 'save-slot:legacy'
            ).directory
            await rm(join(saveDirectory, 'risubard-save-vcs.json'))
            const manifest = join(saveDirectory, 'risubard-save.json')
            await writeFile(manifest, '{')

            await expect(service.deleteMemorySave({
                characterId: 'character', saveId: 'legacy',
            })).rejects.toThrow()
            await expect(readFile(manifest, 'utf8')).resolves.toBe('{')
        }
        finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    test('surfaces detailed materialization conflicts from pending recovery', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const root = await mkdtemp(join(tmpdir(), 'risubard-runtime-pending-conflict-'))
        try {
            const conflict = 'Wiki operation pending: materialization conflict for wiki/scene.md; found changed, before old, target new. Restore and retry.'
            const recoverOperations = vi.fn(async () => ({
                completed: [], discarded: [], unresolved: ['operation-1'],
                conflicts: [conflict],
            }))
            const service = createRuntimeMemoryService(root, {
                versioning: { recoverOperations },
            })

            await expect(service.saveMarkdownWikiTurn({
                characterId: 'character', chatId: 'chat',
                sourceMessageIds: ['assistant-1'],
                markdown: '# Scene\n\nThe scene changed.',
            })).rejects.toThrow(conflict)
            expect(recoverOperations).toHaveBeenCalledWith({
                characterId: 'character', chatId: 'chat',
            })
        }
        finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    test('overwriting a reference save publishes the v1 slot and removes its autosave pin', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const root = await mkdtemp(join(tmpdir(), 'risubard-runtime-ref-overwrite-'))
        try {
            const { createUserDataRepository } = require('./user-data-repository.cjs')
            const canonical = createUserDataRepository({ dataRoot: root })
            const chat = { id: 'chat-1', name: 'Story', message: [] }
            canonical.importLegacyDatabase({ characters: [{ chaId: 'character', name: 'One', chats: [chat] }] })
            const bytes = new Packr({ useRecords: false }).pack(chat)
            const service = createRuntimeMemoryService(root, { canonicalRepository: canonical })
            await service.writeReferenceAutosave({
                characterId: 'character',
                sourceChatId: 'chat-1',
                saveId: 'save-1',
                sourceChatName: 'Story',
                turnCount: 1,
                chatBytes: bytes,
            })
            expect(await service.wikiRefs({
                characterId: 'character', chatId: 'chat-1', kind: 'autosave',
            })).toContainEqual(expect.objectContaining({ id: 'autosave:save-1' }))

            await service.createMemorySave({
                characterId: 'character',
                sourceChatId: 'chat-1',
                saveId: 'save-1',
                overwrite: true,
                sourceChatName: 'Story',
                turnCount: 2,
                chatBytes: bytes,
            })
            expect(await service.listAllMemorySaves({
                characterId: 'character', sourceChatId: 'chat-1',
            })).toContainEqual(expect.objectContaining({
                saveId: 'save-1', saveFormat: 'v1-snapshot',
            }))
            expect(await service.previewMemorySave({
                characterId: 'character', saveId: 'save-1',
            })).toEqual(bytes)
            expect(await service.wikiRefs({
                characterId: 'character', chatId: 'chat-1', kind: 'autosave',
            })).not.toContainEqual(expect.objectContaining({
                id: 'autosave:save-1',
            }))
            const prepared = await service.prepareMemorySaveLoad({
                characterId: 'character',
                saveId: 'save-1',
                destinationChatId: 'loaded',
            })
            expect(prepared.chatBytes).toEqual(bytes)
            await service.completeMemoryFork({
                characterId: 'character',
                destinationChatId: 'loaded',
                forkToken: prepared.fork.forkToken,
                action: 'finalize',
                chatBase64: new Packr({ useRecords: false }).pack({ ...chat, id: 'loaded' }).toString('base64'),
            })
            expect(canonical.loadChat('character', 'loaded')).toEqual({ ...chat, id: 'loaded' })
        }
        finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    test('repeated compatibility exports replace the target with the newest pinned source', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const root = await mkdtemp(join(tmpdir(), 'risubard-runtime-compat-export-'))
        try {
            const { canonical, chat } = seedCanonicalChat(root)
            const packer = new Packr({ useRecords: false })
            const service = createRuntimeMemoryService(root, { canonicalRepository: canonical })
            const document = await service.saveManualWikiDocument({
                characterId: 'character',
                chatId: 'chat-1',
                type: 'concept',
                title: 'Clock',
                markdown: '# Clock\n\n## State\n\n- First snapshot.',
            })
            const referenceInput = {
                characterId: 'character',
                sourceChatId: 'chat-1',
                saveId: 'reference',
                sourceChatName: 'Story',
                turnCount: 1,
            }
            await service.writeReferenceAutosave({
                ...referenceInput,
                chatBytes: packer.pack(chat),
            })
            await service.exportReferenceSaveCompat({
                characterId: 'character',
                saveId: 'reference',
                targetSaveId: '__compat',
            })

            const newestChat = { ...chat, name: 'Updated story' }
            canonical.replaceChat('character', 'chat-1', chat, newestChat)
            await service.saveManualWikiDocument({
                characterId: 'character',
                chatId: 'chat-1',
                documentId: document.id,
                type: 'concept',
                title: 'Clock',
                markdown: '# Clock\n\n## State\n\n- Newest snapshot.',
            })
            const newestReference = await service.writeReferenceAutosave({
                ...referenceInput,
                chatBytes: packer.pack(newestChat),
            })
            await expect(service.exportReferenceSaveCompat({
                characterId: 'character',
                saveId: 'reference',
                targetSaveId: '__compat',
            })).resolves.toMatchObject({ saveId: '__compat' })
            expect(await service.wikiRefs({
                characterId: 'character', chatId: 'chat-1', kind: 'save',
            })).toContainEqual(expect.objectContaining({
                id: 'save-slot:__compat',
                commitId: newestReference.wikiCommitId,
            }))

            const target = resolveMemoryWorkspace(
                root, 'character', 'save-slot:__compat'
            )
            await expect(readFile(join(
                target.directory, 'wiki', document.relativePath
            ), 'utf8')).resolves.toContain('Newest snapshot.')
        }
        finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    test('serializes source writes behind a workspace fork', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-fork-queue-')
        )
        let releaseFork!: () => void
        let markForkStarted!: () => void
        const forkStarted = new Promise<void>((resolve) => {
            markForkStarted = resolve
        })
        const forkGate = new Promise<void>((resolve) => {
            releaseFork = resolve
        })
        const forkWorkspace = vi.fn(async (input) => {
                markForkStarted()
                await forkGate
                return {
                    mode: input.mode,
                    sourceExists: true,
                    destinationChatId: input.destinationChatId,
                    warnings: [],
                    forkToken: 'fork-token',
                }
            })
        const service = createRuntimeMemoryService(userDataDirectory, {
            forkWorkspace,
        })
        const fork = service.forkMemory({
            characterId: 'character', sourceChatId: 'source',
            destinationCharacterId: 'copy-character',
            destinationChatId: 'copy', mode: 'copy',
        })
        await Promise.race([
            forkStarted,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('fork did not start')),
                1_000
            )),
        ])
        expect(forkWorkspace).toHaveBeenCalledOnce()
        let saveFinished = false
        let destinationSaveFinished = false
        const save = service.saveMarkdownWikiTurn({
            characterId: 'character', chatId: 'source',
            sourceMessageIds: ['assistant-1'],
            markdown: '# 사건\n\n포크 뒤에 저장된다.',
        }).then(() => { saveFinished = true })
        const destinationSave = service.saveMarkdownWikiTurn({
            characterId: 'copy-character', chatId: 'copy',
            sourceMessageIds: ['assistant-2'],
            markdown: '# 복제 사건\n\n목적지 포크 뒤에 저장된다.',
        }).then(() => { destinationSaveFinished = true })

        await Promise.resolve()
        expect(saveFinished).toBe(false)
        expect(destinationSaveFinished).toBe(false)
        releaseFork()
        await Promise.all([fork, save, destinationSave])
        expect(saveFinished).toBe(true)
        expect(destinationSaveFinished).toBe(true)
    })


    test('serializes a bounded Markdown wiki reboot checkpoint', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-snapshot-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)
        await service.saveManualWikiDocument({
            characterId: 'character', chatId: 'reboot-job', type: 'character',
            title: '라비안', markdown: '# 라비안\n\n이전 상태.',
        })

        await expect(service.beginWikiRebootBatch({
            characterId: 'character', chatId: 'reboot-job',
            sourceMessageIds: ['user-1', 'assistant-1'],
            eventSourceGroups: [['user-1', 'assistant-1']],
        })).resolves.toMatchObject({ canonicalCount: 1 })
        const receipt = {
            sourceMessageIds: ['user-1', 'assistant-1'], eventIds: [],
            changes: [], warnings: [], recordedAt: 'now',
        }
        await expect(service.recordWikiRebootBatch({
            characterId: 'character', chatId: 'reboot-job', receipt,
        })).resolves.toEqual(receipt)
        await expect(service.completeWikiRebootBatch({
            characterId: 'character', chatId: 'reboot-job',
            sourceMessageIds: receipt.sourceMessageIds,
        })).resolves.toEqual({ removed: true })
    })

    test('reveals only a persisted wiki document path through the injected opener', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-reveal-')
        )
        const revealFile = vi.fn()
        const service = createRuntimeMemoryService(userDataDirectory, {
            revealFile,
        })
        const page = await service.saveManualWikiDocument({
            characterId: 'character',
            chatId: 'chat',
            type: 'character',
            title: '라비안',
            markdown: '# 라비안\n\n기사.',
        })

        await expect(service.revealWikiDocument({
            characterId: 'character',
            chatId: 'chat',
            documentId: page.id,
        })).resolves.toEqual({ ok: true })
        const workspace = resolveMarkdownWikiWorkspace(
            userDataDirectory,
            'character',
            'chat'
        )
        expect(revealFile).toHaveBeenCalledWith(join(
            workspace.directory,
            ...page.relativePath.split('/')
        ))
    })

    test('loads an empty chat without inventing wiki documents', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-empty-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)

        await expect(service.loadView(
            'character',
            'empty-chat'
        )).resolves.toEqual({
            mode: 'markdown',
            wikiPath: resolveMarkdownWikiWorkspace(
                userDataDirectory,
                'character',
                'empty-chat'
            ).directory,
            health: {
                danglingLinks: [],
                unlinkedDocumentIds: [],
                duplicatePassages: [],
            },
            documents: [],
        })
        await rm(userDataDirectory, { recursive: true, force: true })
    })

    test('loads the TypeScript persistence service from the production runtime', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)

        await service.applyDelta({
            characterId: 'character',
            chatId: 'chat',
            delta: {
                schemaVersion: 1,
                operations: [{
                    type: 'append-event',
                    operationId: 'operation-1',
                    eventId: 'event-1',
                    summary: 'The door opened.',
                    evidence: [{
                        chatId: 'chat',
                        messageId: 'message-1',
                    }],
                }],
            },
            availableEvidence: [{
                chatId: 'chat',
                messageId: 'message-1',
            }],
        })

        const state = await service.loadState('character', 'chat')
        expect(state.events).toHaveLength(1)
        const workspace = resolveMemoryWorkspace(
            userDataDirectory,
            'character',
            'chat'
        )
        const events = await readFile(workspace.eventsFile, 'utf8')
        expect(events).toContain('"operationId":"operation-1"')

        await service.saveSourceBaseline(
            'character',
            'chat',
            'Current situation'
        )
        const view = await service.loadView('character', 'chat')
        expect(view).toEqual({
            mode: 'markdown',
            wikiPath: resolveMarkdownWikiWorkspace(
                userDataDirectory,
                'character',
                'chat'
            ).directory,
            health: {
                danglingLinks: [],
                unlinkedDocumentIds: [],
                duplicatePassages: [],
            },
            documents: [],
        })
    })

    test('loads and persists strict v2 graph state from the production runtime', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-graph-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)
        const evidence = [{
            chatId: 'chat',
            messageId: 'message-1',
        }]

        await service.applyGraphDelta({
            characterId: 'character',
            chatId: 'chat',
            delta: {
                schemaVersion: 2,
                storyId: 'character',
                branchId: 'chat',
                operations: [{
                    type: 'add-node',
                    operationId: 'graph-operation-1',
                    node: {
                        id: 'entity:lina',
                        kind: 'entity',
                        subtype: 'character',
                        title: 'Lina',
                        summary: 'Lina is cautious.',
                        storyId: 'character',
                        branchId: 'chat',
                        status: 'active',
                        authority: 'draft',
                        salience: 5,
                        perspective: { kind: 'omniscient' },
                        epistemic: 'fact',
                        evidence,
                    },
                }],
            },
            availableEvidence: evidence,
        })

        await expect(service.loadGraphState(
            'character',
            'chat'
        )).resolves.toMatchObject({
            revision: 1,
            nodes: [{ id: 'entity:lina' }],
        })
        await expect(service.readGraphForInquiry(
            'character',
            'chat'
        )).resolves.toMatchObject({
            mode: 'v2',
            index: { revision: 1 },
        })
        const view = await service.loadView(
            'character',
            'chat'
        )
        expect(view).toEqual({
            mode: 'markdown',
            wikiPath: resolveMarkdownWikiWorkspace(
                userDataDirectory,
                'character',
                'chat'
            ).directory,
            health: {
                danglingLinks: [],
                unlinkedDocumentIds: [],
                duplicatePassages: [],
            },
            documents: [],
        })

        const restarted = createRuntimeMemoryService(userDataDirectory)
        await expect(restarted.loadView(
            'character',
            'chat'
        )).resolves.toMatchObject({
            mode: 'markdown',
            documents: [],
        })

        const graphWorkspace = resolveNarrativeGraphWorkspace(
            userDataDirectory,
            'character',
            'chat'
        )
        await writeFile(graphWorkspace.stateFile, '{broken', 'utf8')
        const corrupted = createRuntimeMemoryService(userDataDirectory)
        await expect(corrupted.loadView(
            'character',
            'chat'
        )).resolves.toMatchObject({
            mode: 'markdown',
            documents: [],
        })
    })

    test('reconciles a dirty graph from current v1 state', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-reconcile-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)
        const evidence = [{
            chatId: 'chat',
            messageId: 'message-1',
        }]
        await service.applyDelta({
            characterId: 'character',
            chatId: 'chat',
            delta: {
                schemaVersion: 1,
                operations: [{
                    type: 'add-fact',
                    operationId: 'operation-fact',
                    factId: 'door-state',
                    text: 'The door is open.',
                    evidence,
                }],
            },
            availableEvidence: evidence,
        })
        await expect(service.applyGraphDelta({
            characterId: 'character',
            chatId: 'chat',
            delta: {
                schemaVersion: 2,
                storyId: 'character',
                branchId: 'chat',
                operations: [{
                    type: 'update-node-status',
                    operationId: 'operation-invalid',
                    nodeId: 'claim:v1:door-state',
                    status: 'invalidated',
                    evidence,
                }],
            },
            availableEvidence: evidence,
        })).rejects.toThrow()
        await expect(service.loadView(
            'character',
            'chat'
        )).resolves.toMatchObject({
            mode: 'markdown',
            documents: [],
        })

        await expect(service.reconcileGraphV1(
            'character',
            'chat'
        )).resolves.toMatchObject({
            nodes: [{
                id: 'claim:v1:door-state',
                status: 'active',
            }],
        })
        await expect(service.readGraphForInquiry(
            'character',
            'chat'
        )).resolves.toMatchObject({ mode: 'v2' })
    })

    test('promotes an existing mention into v1 prompt memory and native v2 character state', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-writer-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)
        const evidence = [{
            chatId: 'chat',
            messageId: 'message-market',
        }]
        await service.applyDelta({
            characterId: 'character',
            chatId: 'chat',
            delta: {
                schemaVersion: 1,
                operations: [{
                    type: 'append-event',
                    operationId: 'market-event',
                    eventId: 'market-collision',
                    summary:
                        'The protagonist collided with a blue-haired elf.',
                    evidence,
                }],
            },
            availableEvidence: evidence,
        })
        await service.reconcileGraphV1('character', 'chat')
        const command = {
            schemaVersion: 1,
            type: 'promote-character',
            commandId: 'promotion-eliana',
            storyId: 'character',
            branchId: 'chat',
            sourceNodeId: 'event:v1:market-collision',
            name: 'Eliana',
            summary: 'Eliana is the blue-haired elf from the market.',
            salience: 9,
        }

        await expect(service.applyWriterCommand({
            characterId: 'character',
            chatId: 'chat',
            expectedRevision: 1,
            command,
        })).resolves.toEqual({ revision: 2 })

        await expect(service.loadState(
            'character',
            'chat'
        )).resolves.toMatchObject({
            facts: [{
                id: 'writer:promotion-eliana:character-fact',
                text: 'Eliana is the blue-haired elf from the market.',
                status: 'active',
            }],
        })
        await expect(service.loadGraphState(
            'character',
            'chat'
        )).resolves.toMatchObject({
            revision: 2,
            nodes: expect.arrayContaining([
                expect.objectContaining({
                    id: 'entity:writer:promotion-eliana',
                    kind: 'entity',
                    authority: 'canonical',
                }),
                expect.objectContaining({
                    id:
                        'claim:v1:writer:promotion-eliana:character-fact',
                }),
            ]),
            edges: expect.arrayContaining([
                expect.objectContaining({
                    type: 'involves',
                    targetId: 'entity:writer:promotion-eliana',
                }),
                expect.objectContaining({
                    type: 'about',
                    targetId: 'entity:writer:promotion-eliana',
                }),
            ]),
        })

        await expect(service.applyWriterCommand({
            characterId: 'character',
            chatId: 'chat',
            expectedRevision: 2,
            command,
        })).resolves.toEqual({ revision: 2 })

        const restarted = createRuntimeMemoryService(userDataDirectory)
        await expect(restarted.loadView(
            'character',
            'chat'
        )).resolves.toMatchObject({
            mode: 'markdown',
            documents: [],
        })
    })

    test('rejects a stale writer revision before changing v1 memory', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-writer-stale-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)

        await expect(service.applyWriterCommand({
            characterId: 'character',
            chatId: 'chat',
            expectedRevision: 1,
            command: {
                schemaVersion: 1,
                type: 'promote-character',
                commandId: 'promotion-eliana',
                storyId: 'character',
                branchId: 'chat',
                sourceNodeId: 'event:v1:market-collision',
                name: 'Eliana',
                summary: 'Eliana is the blue-haired elf from the market.',
                salience: 9,
            },
        })).rejects.toThrow('Writer graph revision is stale')

        await expect(service.loadState(
            'character',
            'chat'
        )).resolves.toMatchObject({ facts: [], events: [] })
    })
})

describe('interrupted legacy Wiki directory swaps', () => {
    test('restores a unique original tree before exposing a restarted chat', async () => {
        const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
        const root = await mkdtemp(join(tmpdir(), 'risubard-legacy-swap-'))
        try {
            const input = { characterId: 'character', chatId: 'chat' }
            let service = createRuntimeMemoryService(root)
            const saved = await service.saveManualWikiDocument({
                ...input, type: 'concept', title: 'Clock',
                markdown: '## Clock\n\nOriginal state.',
            })
            const workspace = resolveMarkdownWikiWorkspace(root, input.characterId, input.chatId)
            const file = join(workspace.directory, saved.relativePath)
            const externalBytes = (await readFile(file, 'utf8')).replace('Original state.', 'External fact before interruption.')
            await writeFile(file, externalBytes)
            await rename(workspace.directory,
                `${workspace.directory}.write-backup-11111111-1111-4111-8111-111111111111`)
            service = createRuntimeMemoryService(root)
            const restored = await service.loadView(input.characterId, input.chatId)
            expect(restored.documents.find((document: { id: string }) => document.id === saved.id)?.content)
                .toContain('External fact before interruption.')
            expect(await readFile(file, 'utf8')).toBe(externalBytes)
        }
        finally { await rm(root, { recursive: true, force: true }) }
    })
})

describe('joint canonical chat and Wiki checkout recovery', () => {
    test('replays the chat snapshot after checkout fails between Wiki and canonical publication', async () => {
        const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
        const { createUserDataRepository } = require('./user-data-repository.cjs')
        const root = await mkdtemp(join(tmpdir(), 'risubard-joint-checkout-'))
        try {
            const input = { characterId: 'character', chatId: 'chat' }
            const messages = ['one', 'two', 'three'].map((data, index) => ({
                chatId: `m${index + 1}`, role: 'char', data,
            }))
            const chat = { id: input.chatId, name: 'Story', message: messages, scriptstate: { '$score': 300 } }
            const canonical = createUserDataRepository({ dataRoot: root })
            canonical.importLegacyDatabase({ characters: [{ chaId: input.characterId, name: 'Character', chatPage: 0, chats: [chat] }] }, { mode: 'replace' })
            const anchor = (count: number) => chatBoundaryAnchor(input.chatId, `m${count}`, messages.slice(0, count).map(message => ({
                messageId: message.chatId, role: 'assistant', data: message.data,
            })))
            let service = createRuntimeMemoryService(root, { canonicalRepository: canonical })
            const first = await service.saveManualWikiDocument({
                ...input, type: 'concept', title: 'Clock',
                markdown: '## Clock\n\n### State\n\n- One.', chatAnchor: anchor(1),
            })
            await service.saveManualWikiDocument({
                ...input, type: 'concept', title: 'Clock', documentId: first.id,
                markdown: '## Clock\n\n### State\n\n- Three.', chatAnchor: anchor(3),
            })
            const head = (await service.wikiHistory(input))[0].commitId
            let fail = true
            service = createRuntimeMemoryService(root, {
                canonicalRepository: {
                    ...canonical,
                    replaceChat(...args: unknown[]) {
                        if (fail) { fail = false; throw new Error('injected ENOSPC') }
                        return canonical.replaceChat(...args)
                    },
                },
            })
            const target = { ...chat, message: messages.slice(0, 1), scriptstate: { '$score': 100 } }
            await expect(service.wikiCheckout({
                ...input, commitId: first.vcsCommitId, operationId: 'checkout-at-one',
                reason: 'truncate', expectedChatAnchor: anchor(3),
                chatBase64: new Packr({ useRecords: false }).pack(target).toString('base64'),
            })).rejects.toThrow('injected ENOSPC')
            expect(canonical.loadChat(input.characterId, input.chatId).message).toEqual(messages)
            service = createRuntimeMemoryService(root, { canonicalRepository: canonical })
            await service.recoverWikiOperations()
            expect(canonical.loadChat(input.characterId, input.chatId)).toEqual(target)
            expect((await service.wikiHistory(input))[0].commitId).toBe(first.vcsCommitId)
            expect((await service.loadView(input.characterId, input.chatId)).documents.find((document: { id: string }) => document.id === first.id)?.content)
                .toContain('- One.')
            const refs = await service.wikiRefs({ ...input, kind: 'recovery' })
            expect(refs.some((ref: { commitId: string; chatStateRef?: string }) => ref.commitId === head && ref.chatStateRef)).toBe(true)
        }
        finally { await rm(root, { recursive: true, force: true }) }
    })
})

describe('Wiki reboot version seeds', () => {
    test('seeds a historical Wiki tree without adding a canonical chat', async () => {
        const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
        const { createUserDataRepository } = require('./user-data-repository.cjs')
        const root = await mkdtemp(join(tmpdir(), 'risubard-reboot-seed-'))
        try {
            const canonical = createUserDataRepository({ dataRoot: root })
            const chat = { id: 'source', name: 'Story', message: [] }
            canonical.importLegacyDatabase({ characters: [{ chaId: 'character', name: 'One', chats: [chat] }] })
            const before = canonical.exportLegacyDatabase()
            const service = createRuntimeMemoryService(root, { canonicalRepository: canonical })
            const first = await service.saveManualWikiDocument({
                characterId: 'character', chatId: 'source', type: 'concept',
                title: 'Clock', markdown: '## Clock\n\nBefore the gate.',
            })
            await service.saveManualWikiDocument({
                characterId: 'character', chatId: 'source', type: 'concept', documentId: first.id,
                title: 'Clock', markdown: '## Clock\n\nAfter the gate.',
            })
            await service.seedWikiReboot({
                characterId: 'character', sourceChatId: 'source',
                stagingChatId: 'reboot-seed', commitId: first.vcsCommitId,
            })
            expect((await service.loadView('character', 'reboot-seed')).documents[0].content).toContain('Before the gate.')
            expect((await service.loadView('character', 'source')).documents[0].content).toContain('After the gate.')
            expect(canonical.exportLegacyDatabase()).toEqual(before)
            await service.removeRebootMemory({ characterId: 'character', chatId: 'reboot-seed' })
            expect((await service.loadView('character', 'reboot-seed')).documents).toEqual([])
        } finally { await rm(root, { recursive: true, force: true }) }
    })
})

describe('VCS synchronization regression', () => {
    const owner = { characterId: 'character', chatId: 'chat-1' }
    const packer = new Packr({ useRecords: false })
    const anchorFor = (chat: Chat, boundary: string) => chatBoundaryAnchor(chat.id!, boundary,
        chat.message.slice(0, chat.message.findIndex(message => message.chatId === boundary) + 1)
            .map(message => ({ messageId: message.chatId!, role: message.role === 'char'
                ? 'assistant' as const : 'user' as const, data: message.data })))

    async function publishAnalysis(service: any, chat: Chat, operationId: string,
        boundary = 'm1', sourceMessageIds = [boundary], immutable = true) {
        const chatAnchor = anchorFor(chat, boundary)
        await service.beginWikiWriteBatch({ ...owner, operationId, kind: 'analysis', chatAnchor,
            expectedHead: (await service.ensureWikiVersion(owner)).commitId })
        const event = await service.saveMarkdownWikiTurn({ ...owner, operationId, chatAnchor,
            sourceMessageIds, markdown: `# Arrival\n\n## Established events\n\n- ${operationId} at the keep.` })
        const receipt = { sourceMessageIds, eventIds: [event.id], changes: [], warnings: [],
            recordedAt: '2026-09-01T00:00:00.000Z' }
        const published = await service.publishWikiWriteBatch({ ...owner, operationId, chatAnchor,
            ...(immutable ? { analysisReceipt: receipt } : {}) })
        return { ...published, receipt: { ...receipt, vcsCommitIds: [published.commitId] } }
    }

    test('rejects stale chat snapshots for both reference and manual saves', async () => {
        const root = await mkdtemp(join(tmpdir(), 'risubard-sync-save-'))
        try {
            const { canonical, chat } = seedCanonicalChat(root)
            const future = { ...chat, message: [...chat.message,
                { chatId: 'm2', role: 'char', data: 'Aria leaves the keep.' }] }
            canonical.replaceChat('character', 'chat-1', chat, future)
            const service = require('./risubard-memory-runtime.cjs').createRuntimeMemoryService(root,
                { canonicalRepository: canonical })
            await service.saveManualWikiDocument({ ...owner, type: 'concept', title: 'Keep',
                markdown: '# Keep\n\n## State\n\n- Aria has left.' })
            const input = { characterId: 'character', sourceChatId: 'chat-1', saveId: 'slot',
                sourceChatName: 'Story', turnCount: 1, chatBytes: packer.pack(chat) }
            await expect(service.writeReferenceAutosave(input)).rejects.toThrow('Wiki chat conflict')
            await expect(service.createMemorySave(input)).rejects.toThrow('Wiki chat conflict')
            expect(await service.listAllMemorySaves({ characterId: 'character', sourceChatId: 'chat-1' })).toEqual([])
            const saved = await service.writeReferenceAutosave({ ...input, turnCount: 2,
                chatBytes: packer.pack(canonical.loadChat('character', 'chat-1')) })
            expect(saved.wikiCommitId).toBe((await service.ensureWikiVersion(owner)).commitId)
            const current = canonical.loadChat('character', 'chat-1')
            canonical.replaceChat('character', 'chat-1', current, { ...current, scriptstate: { score: 2 } })
            await expect(service.writeReferenceAutosave({ ...input, saveId: 'stale-header',
                turnCount: 2, chatBytes: packer.pack(current) })).rejects.toThrow('Wiki chat conflict')
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test('accepts stripped story snapshots without accepting stale story variables', async () => {
        const root = await mkdtemp(join(tmpdir(), 'risubard-sync-story-snapshot-'))
        try {
            const { canonical, chat } = seedCanonicalChat(root, {
                id: 'chat-1', name: 'Story', note: '', localLore: [],
                message: [{ chatId: 'm1', role: 'char', data: 'Aria is at the keep.' }],
                scriptstate: { score: 1 },
                GLGlobalVariables: { toggle_lamp: 'on', door: 'closed' },
                useModelPreset: true, bindedPersona: 'persona-1',
                _placeholder: false, isStreaming: true,
            })
            const service = require('./risubard-memory-runtime.cjs').createRuntimeMemoryService(root,
                { canonicalRepository: canonical })
            await service.saveManualWikiDocument({ ...owner, type: 'concept', title: 'Keep',
                markdown: '# Keep\n\n## State\n\n- The door is closed.' })
            const snapshot = structuredClone(chat)
            prepareMemorySaveChatSnapshot(snapshot)
            const input = { characterId: 'character', sourceChatId: 'chat-1', saveId: 'story',
                sourceChatName: 'Story', turnCount: 1, chatBytes: packer.pack(snapshot) }
            const saved = await service.writeReferenceAutosave(input)
            const repository = createWikiVcsRepository(root)
            const contents = await repository.readChatState({ ...owner, hash: saved.chatHash })
            const restored = new Unpackr({ useRecords: false }).unpack(Buffer.from(contents!, 'base64'))
            expect(restored.message).toEqual(chat.message)
            expect(restored.scriptstate).toEqual({ score: 1 })
            expect(restored.GLGlobalVariables).toEqual({ door: 'closed' })
            const current = canonical.loadChat('character', 'chat-1')
            canonical.replaceChat('character', 'chat-1', current, {
                ...current, GLGlobalVariables: { toggle_lamp: 'off', door: 'open' },
            })
            await expect(service.createMemorySave({ ...input, saveId: 'stale-story' }))
                .rejects.toThrow('Wiki chat conflict')
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test('pins analysis before the model reads instead of overwriting an intervening manual edit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'risubard-sync-analysis-'))
        try {
            const { canonical, chat } = seedCanonicalChat(root)
            const service = require('./risubard-memory-runtime.cjs').createRuntimeMemoryService(root,
                { canonicalRepository: canonical })
            const document = await service.saveManualWikiDocument({ ...owner, type: 'concept',
                title: 'Keep', markdown: '# Keep\n\n## State\n\n- Original.' })
            let editedHead: string | null = null
            const runner = createMemoryAnalysisRunner({
                memoryService: createNarrativeMemoryService(root), nativeV2Analysis: true,
                markdownWikiService: {
                    readHead: async (characterId, chatId) => {
                        await service.captureWikiExternalChanges({ characterId, chatId })
                        return (await service.ensureWikiVersion({ characterId, chatId })).commitId
                    },
                    loadDocuments: async (characterId, chatId) => (await service.loadView(characterId, chatId)).documents,
                    inquire: input => service.inquireNarrative(input),
                    beginWriteBatch: input => service.beginWikiWriteBatch(input),
                    saveConfirmedTurn: input => service.saveMarkdownWikiTurn(input),
                    publishWriteBatch: input => service.publishWikiWriteBatch(input),
                    abandonWriteBatch: input => service.abandonWikiWriteBatch(input),
                },
                analyze: async () => {
                    await service.saveManualWikiDocument({ ...owner, documentId: document.id,
                        type: 'concept', title: 'Keep', markdown: '# Keep\n\n## State\n\n- Intervening manual edit.' })
                    editedHead = (await service.ensureWikiVersion(owner)).commitId
                    return JSON.stringify({ schemaVersion: 1, title: 'Arrival',
                        establishedEvents: ['Aria is at the keep.'], stateChanges: [], characterKnowledge: [],
                        persistentFacts: [], openContinuity: [], canonicalUpdateCandidates: [], keywords: ['keep'] })
                },
                onError: () => {},
            })
            await expect(runner.run({ ...owner, chatAnchor: anchorFor(chat, 'm1'),
                messages: [{ messageId: 'm1', role: 'assistant', content: chat.message[0].data }] }))
                .rejects.toThrow('branch head changed')
            expect((await service.ensureWikiVersion(owner)).commitId).toBe(editedHead)
            expect((await service.loadView('character', 'chat-1')).documents
                .find((item: { id: string }) => item.id === document.id).content).toContain('Intervening manual edit.')
            expect(canonical.loadChat('character', 'chat-1').message[0].risubardMemoryConfirmed).not.toBe(true)
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test('recovers confirmation and the immutable receipt after canonical publication fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'risubard-sync-receipt-'))
        try {
            const { canonical, chat } = seedCanonicalChat(root)
            const failure = vi.spyOn(canonical, 'replaceChat').mockImplementationOnce(() => {
                throw Object.assign(new Error('Injected canonical EIO'), { code: 'EIO' })
            })
            let service = require('./risubard-memory-runtime.cjs').createRuntimeMemoryService(root,
                { canonicalRepository: canonical })
            await expect(publishAnalysis(service, chat, 'interrupted-analysis')).rejects.toThrow('Injected canonical EIO')
            expect(canonical.loadChat('character', 'chat-1').message[0].risubardMemoryConfirmed).not.toBe(true)
            failure.mockRestore()
            service = require('./risubard-memory-runtime.cjs').createRuntimeMemoryService(root,
                { canonicalRepository: canonical })
            await service.recoverWikiOperations()
            const message = canonical.loadChat('character', 'chat-1').message[0]
            expect(message.risubardMemoryConfirmed).toBe(true)
            const commitId = message.risubardCanonicalReceipt.vcsCommitIds[0]
            expect((await service.ensureWikiVersion(owner)).commitId).toBe(commitId)
            expect(await service.wikiAnalysisReceipt({ ...owner, commitId })).toEqual({
                provenance: 'commit', receipt: message.risubardCanonicalReceipt,
            })
            await service.recoverWikiOperations()
            expect(canonical.loadChat('character', 'chat-1').message[0]).toEqual(message)
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test('rejects split inquiry after an atomic edit even when the document count is unchanged', async () => {
        const root = await mkdtemp(join(tmpdir(), 'risubard-sync-inquiry-'))
        try {
            const { canonical, chat } = seedCanonicalChat(root)
            const service = require('./risubard-memory-runtime.cjs').createRuntimeMemoryService(root,
                { canonicalRepository: canonical })
            const document = await service.saveManualWikiDocument({ ...owner, type: 'concept',
                title: 'Keep rule', markdown: '# Keep rule\n\n## State\n\n- OLD_PAIR at the keep.' })
            await service.setWikiDocumentContextMode({ ...owner, documentId: document.id, contextMode: 'always' })
            await service.saveManualWikiDocument({ ...owner, type: 'concept',
                title: 'Keep detail', markdown: '# Keep detail\n\n## State\n\n- OLD_PAIR at the keep.' })
            const required = await service.inquireNarrative({ ...owner, currentInput: '', contextSelection: 'required' })
            const auto = await service.inquireNarrative({ ...owner, currentInput: 'keep detail',
                contextSelection: 'auto', expectedWikiCommitId: required.wikiCommitId })
            expect(auto.wikiCommitId).toBe(required.wikiCommitId)
            expect(auto.sources.some((source: { id: string }) =>
                required.sources.some((other: { id: string }) => other.id === source.id))).toBe(false)
            const repository = createWikiVcsRepository(root)
            const paths = await repository.readPathMap('character', 'chat-1', required.wikiCommitId)
            const workspace = resolveWikiVcsRepository(root, 'character', 'chat-1')
            await repository.publishChanges({ ...owner, operationId: 'atomic-pair', kind: 'manual',
                expectedHead: required.wikiCommitId, chatAnchor: anchorFor(chat, 'm1'),
                changes: await Promise.all(Object.keys(paths).map(async path => ({
                    path, contents: (await readFile(join(workspace.workingTreeDirectory, path), 'utf8'))
                        .replaceAll('OLD_PAIR', 'NEW_PAIR'),
                }))) })
            await expect(service.inquireNarrative({ ...owner, currentInput: 'keep detail',
                contextSelection: 'auto', expectedWikiCommitId: required.wikiCommitId }))
                .rejects.toThrow('Wiki inquiry conflict:')
            const refreshed = await service.inquireNarrative({ ...owner, currentInput: '', contextSelection: 'required' })
            expect(refreshed.graphRevision).toBe(required.graphRevision)
            expect(refreshed.wikiCommitId).not.toBe(required.wikiCommitId)
            expect(refreshed.sources.some((source: { content: string }) => source.content.includes('NEW_PAIR'))).toBe(true)
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test('retains a deleted chat until its final recovery ref is purged, then reclaims its blobs', async () => {
        const root = await mkdtemp(join(tmpdir(), 'risubard-sync-purge-'))
        try {
            const { canonical, chat } = seedCanonicalChat(root)
            const service = require('./risubard-memory-runtime.cjs').createRuntimeMemoryService(root,
                { canonicalRepository: canonical })
            const published = await publishAnalysis(service, chat, 'restorable-arrival')
            for (const id of ['deleted:first', 'deleted:last']) {
                await service.createWikiRef({ ...owner, kind: 'recovery', id, reason: 'chat-delete',
                    commitId: published.commitId, chatBase64: packer.pack(canonical.loadChat('character', 'chat-1')).toString('base64') })
            }
            canonical.importLegacyDatabase({ characters: [{ chaId: 'character', name: 'Aria', chats: [] }] }, { mode: 'sync' })
            await service.deleteWikiRef({ ...owner, kind: 'recovery', id: 'deleted:first' })
            const repository = createWikiVcsRepository(root)
            expect((await repository.readLink('character', 'chat-1'))?.materializedCommitId).toBe(published.commitId)
            expect((await service.readWikiRecovery({ ...owner, id: 'deleted:last' })).ref.commitId).toBe(published.commitId)
            await expect(service.wikiAnalysisReceipt({ ...owner, commitId: published.commitId }))
                .resolves.toEqual({ provenance: 'commit', receipt: published.receipt })
            await service.deleteWikiRef({ ...owner, kind: 'recovery', id: 'deleted:last' })
            expect(await repository.readLink('character', 'chat-1')).toBeUndefined()
            await expect(service.wikiAnalysisReceipt({ ...owner, commitId: published.commitId }))
                .rejects.toMatchObject({ code: 'ENOENT' })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test.each(['immutable', 'legacy'] as const)('restores a greeting receipt without retaining future reanalysis (%s)', async kind => {
        const root = await mkdtemp(join(tmpdir(), 'risubard-sync-fork-'))
        let server: import('node:http').Server | undefined
        try {
            const { canonical, chat } = seedCanonicalChat(root)
            const service = require('./risubard-memory-runtime.cjs').createRuntimeMemoryService(root,
                { canonicalRepository: canonical })
            const first = await publishAnalysis(service, chat, 'first-arrival', 'm1',
                ['first-message:chat-1:-1', 'm1'], kind === 'immutable')
            if (kind === 'legacy') {
                const before = canonical.loadChat('character', 'chat-1')
                canonical.replaceChat('character', 'chat-1', before, { ...before,
                    message: [{ ...before.message[0], risubardMemoryConfirmed: true, risubardCanonicalReceipt: first.receipt }] })
            }
            const express = require('express')
            const app = express()
            app.use(express.json({ limit: '16mb' }))
            require('./risubard-memory-routes.cjs').registerRisuBardMemoryRoutes(app, { service, auth: async () => true })
            server = app.listen(0, '127.0.0.1')
            await new Promise<void>(resolve => server!.once('listening', resolve))
            const base = `http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}`
            const transport = { fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => fetch(base + String(input), init),
                createAuth: async () => 'auth' }
            if (kind === 'legacy') {
                const complete: Chat = { ...canonical.loadChat('character', 'chat-1'), id: 'legacy-full' }
                await forkWikiVersion({ characterId: 'character', sourceChatId: 'chat-1',
                    destinationChatId: complete.id!, commitId: first.commitId, chat: complete, ...transport })
                expect(canonical.loadChat('character', complete.id).message[0].risubardCanonicalReceipt).toEqual(first.receipt)
                expect(canonical.loadChat('character', complete.id).message[0].risubardMemoryConfirmed).toBe(true)
            }
            const before = canonical.loadChat('character', 'chat-1')
            canonical.replaceChat('character', 'chat-1', before, { ...before, message: [
                ...before.message, { chatId: 'm2', role: 'char', data: 'Future scene.' },
            ] })
            await publishAnalysis(service, canonical.loadChat('character', 'chat-1'), 'future-scene', 'm2')
            await publishAnalysis(service, canonical.loadChat('character', 'chat-1'), 'late-reanalysis')
            const current = canonical.loadChat('character', 'chat-1')
            const past: Chat = { ...current, id: 'past', message: [current.message[0]] }
            await forkWikiVersion({ characterId: 'character', sourceChatId: 'chat-1',
                destinationChatId: 'past', commitId: first.commitId, chat: past, ...transport })
            const restored = canonical.loadChat('character', 'past').message[0]
            expect(restored.risubardCanonicalReceipt.vcsCommitIds).toEqual([first.commitId])
            expect(restored.risubardCanonicalReceipt.eventIds).toEqual(first.receipt.eventIds)
            expect(restored.risubardMemoryConfirmed).toBe(kind === 'immutable')
            const documents = (await service.loadView('character', 'past')).documents
            const content = documents.map((document: { content: string }) => document.content).join('\n')
            expect(content).toContain('first-arrival')
            expect(content).not.toContain('future-scene')
            expect(content).not.toContain('late-reanalysis')
        } finally {
            if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
            await rm(root, { recursive: true, force: true })
        }
    })
})
