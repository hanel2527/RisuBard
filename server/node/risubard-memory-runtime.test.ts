import { createRequire } from 'node:module'
import { access, mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import { resolveNarrativeGraphWorkspace } from './risubard-graph-workspace'
import { resolveMarkdownWikiWorkspace } from './risubard-markdown-wiki'

const require = createRequire(import.meta.url)

describe('RisuBard memory CommonJS runtime', () => {
    test('restores a v1 save at its pinned Wiki head after a runtime restart', async () => {
        const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
        const root = await mkdtemp(join(tmpdir(), 'risubard-runtime-save-restore-'))
        try {
            let service = createRuntimeMemoryService(root)
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
                chatBytes: Buffer.from([1, 2]),
            })
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
            service = createRuntimeMemoryService(root)
            await service.completeMemoryFork({
                characterId: 'character', destinationChatId: 'chat-1',
                forkToken: prepared.fork.forkToken, action: 'finalize',
            })
            expect((await service.wikiHistory({
                characterId: 'character', chatId: 'chat-1',
            }))[0].commitId).toBe(savedHead)
            expect((await service.loadView('character', 'chat-1')).documents[0].content)
                .toContain('Before the gate.')
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
            const service = createRuntimeMemoryService(root)
            const saveInput = {
                characterId: 'character', sourceChatId: 'chat-1',
                saveId: 'legacy', sourceChatName: 'Story', turnCount: 1,
                chatBytes: Buffer.from('legacy chat'),
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

            await service.createMemorySave({
                ...saveInput, chatBytes: Buffer.from('recreated chat'),
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
            const service = createRuntimeMemoryService(root)
            await service.createMemorySave({
                characterId: 'character', sourceChatId: 'chat-1',
                saveId: 'legacy', sourceChatName: 'Story', turnCount: 1,
                chatBytes: Buffer.from('legacy chat'),
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
            const service = createRuntimeMemoryService(root)
            await service.writeReferenceAutosave({
                characterId: 'character',
                sourceChatId: 'chat-1',
                saveId: 'save-1',
                sourceChatName: 'Story',
                turnCount: 1,
                chatBytes: Buffer.from('reference chat'),
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
                chatBytes: Buffer.from('new v1 chat'),
            })
            expect(await service.listAllMemorySaves({
                characterId: 'character', sourceChatId: 'chat-1',
            })).toContainEqual(expect.objectContaining({
                saveId: 'save-1', saveFormat: 'v1-snapshot',
            }))
            expect(await service.previewMemorySave({
                characterId: 'character', saveId: 'save-1',
            })).toEqual(Buffer.from('new v1 chat'))
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
            expect(prepared.chatBytes).toEqual(Buffer.from('new v1 chat'))
            await service.completeMemoryFork({
                characterId: 'character',
                destinationChatId: 'loaded',
                forkToken: prepared.fork.forkToken,
                action: 'finalize',
            })
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
            const service = createRuntimeMemoryService(root)
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
                chatBytes: Buffer.from('first chat state'),
            })
            await service.exportReferenceSaveCompat({
                characterId: 'character',
                saveId: 'reference',
                targetSaveId: '__compat',
            })

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
                chatBytes: Buffer.from('newest chat state'),
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
            await expect(service.previewMemorySave({
                characterId: 'character', saveId: '__compat',
            })).resolves.toEqual(Buffer.from('newest chat state'))
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

    test('serializes fork completion on the destination workspace', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-fork-complete-')
        )
        const completeForkWorkspace = vi.fn(async (input) => ({
            action: input.action,
            completed: true,
        }))
        const service = createRuntimeMemoryService(userDataDirectory, {
            completeForkWorkspace,
        })

        await expect(service.completeMemoryFork({
            characterId: 'character', destinationChatId: 'copy',
            forkToken: 'fork-token', action: 'finalize',
        })).resolves.toEqual({ action: 'finalize', completed: true })
        expect(completeForkWorkspace).toHaveBeenCalledWith({
            userDataDirectory,
            characterId: 'character', destinationChatId: 'copy',
            forkToken: 'fork-token', action: 'finalize',
        })
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
