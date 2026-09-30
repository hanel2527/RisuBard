import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { Server } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { chatBoundaryAnchor, type WikiAnchorMessage, type WikiChatAnchor } from '../../src/ts/risubard/wikiVcsContract'
import { createWikiVersioning } from './risubard-wiki-versioning'
import { createMarkdownNarrativeWiki } from './risubard-markdown-wiki'
import {
    memorySaveWorkspaceId,
    readMemorySaveReference,
    writeMemorySaveReference,
} from './risubard-memory-save'
import {
    createWikiVcsRepository,
    resolveWikiVcsRepository,
} from './risubard-wiki-vcs'

import {
    findWikiCommitForPrefix,
    previewWikiCheckout,
    checkoutWikiVersion,
} from '../../src/ts/risubard/wikiVersionClient'

const require = createRequire(import.meta.url)
const roots: string[] = []

async function createRoot(): Promise<string> {
    const root = await fs.mkdtemp(join(tmpdir(), 'risubard-wiki-integration-'))
    roots.push(root)
    return root
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
        fs.rm(root, { recursive: true, force: true })
    ))
})

const chat = 'chat-integration'

function anchorAt(messageId: string | null) {
    return chatBoundaryAnchor(
        chat,
        messageId,
        [{
            messageId: messageId ?? 'message-0',
            role: 'assistant',
            data: `content at ${messageId}`,
        }]
    )
}

describe('wiki writes become version history', () => {
    test('every supported write path publishes a commit without being asked', async () => {
        const root = await createRoot()
        const versioning = createWikiVersioning(root)
        const wiki = createMarkdownNarrativeWiki(root, { versioning })

        // A confirmed turn is the first thing that touches a fresh chat, so the
        // wiki must be able to commit before any explicit baseline call.
        const event = await wiki.saveConfirmedTurn({
            characterId: 'character',
            chatId: chat,
            sourceMessageIds: ['assistant-1'],
            markdown: '## The gate opened\n\n### Story\n\n- The gate opened.',
            chatAnchor: anchorAt('assistant-1'),
        })
        expect(event.vcsCommitId).toMatch(/^[a-f0-9]{64}$/)

        const canonical = await wiki.saveCanonicalDocument({
            characterId: 'character',
            chatId: chat,
            type: 'character',
            title: 'Aria',
            sourceMessageIds: ['assistant-1'],
            markdown: '# Aria\n\n## Current state\n\n- At the gate.',
            chatAnchor: anchorAt('assistant-1'),
        })
        expect(canonical.vcsCommitId).toMatch(/^[a-f0-9]{64}$/)

        const manual = await wiki.saveManualDocument({
            characterId: 'character',
            chatId: chat,
            documentId: canonical.id,
            type: 'character',
            title: 'Aria',
            markdown: '# Aria\n\n## Current state\n\n- Inside the keep.',
        })
        expect(manual.vcsCommitId).toMatch(/^[a-f0-9]{64}$/)

        const history = await versioning.listHistory({
            characterId: 'character',
            chatId: chat,
        })
        expect(history.length).toBeGreaterThanOrEqual(3)
        // Every commit names the operation it came from.
        expect(history.map((entry) => entry.kind)).toEqual(
            expect.arrayContaining(['analysis', 'manual'])
        )
    })

    test('rewinding restores bytes and keeps the replaced future recoverable', async () => {
        const root = await createRoot()
        const versioning = createWikiVersioning(root)
        const wiki = createMarkdownNarrativeWiki(root, { versioning })

        const first = await wiki.saveCanonicalDocument({
            characterId: 'character',
            chatId: chat,
            type: 'item',
            title: 'Sword',
            sourceMessageIds: ['assistant-1'],
            markdown: '# Sword\n\n## State\n\n- Sheathed.',
            chatAnchor: anchorAt('assistant-1'),
        })
        await wiki.saveManualDocument({
            characterId: 'character',
            chatId: chat,
            documentId: first.id,
            type: 'item',
            title: 'Sword',
            markdown: '# Sword\n\n## State\n\n- Drawn and broken.',
        })

        const history = await versioning.listHistory({
            characterId: 'character',
            chatId: chat,
        })
        const target = history.find((entry) =>
            entry.changedPaths.some((path) => path.includes('items/'))
            && entry.kind === 'analysis')
        expect(target).toBeTruthy()

        const result = await versioning.checkout({
            characterId: 'character',
            chatId: chat,
            commitId: target!.commitId,
            reason: 'truncate',
        })
        expect(result.changedPaths.length).toBeGreaterThan(0)
        expect(result.recoveryRefId).toBeTruthy()

        const document = (await wiki.loadView('character', chat))
            .documents.find((item) => item.id === first.id)
        expect(document?.content).toContain('Sheathed.')

        // The replaced future survives as a recovery ref.
        const refs = await versioning.listRefs({
            characterId: 'character',
            chatId: chat,
            kind: 'recovery',
        })
        expect(refs.map((ref) => ref.commitId)).toContain(result.previousHead)
    })

    test('checkout preserves uncommitted on-disk edits instead of discarding them', async () => {
        const root = await createRoot()
        const versioning = createWikiVersioning(root)
        const wiki = createMarkdownNarrativeWiki(root, { versioning })

        const saved = await wiki.saveCanonicalDocument({
            characterId: 'character',
            chatId: chat,
            type: 'concept',
            title: 'Oath',
            sourceMessageIds: ['assistant-1'],
            markdown: '# Oath\n\n## Rule\n\n- Sworn.',
        })
        const workspace = join(
            root, 'risubard', 'characters',
            `id-${Buffer.from('character', 'utf8').toString('base64url')}`,
            'chats',
            `id-${Buffer.from(chat, 'utf8').toString('base64url')}`,
            'wiki'
        )
        const file = join(workspace, ...saved.relativePath.split('/'))
        await fs.writeFile(file, '# Oath\n\n## Rule\n\n- Edited outside the app.')

        const head = await versioning.readHead('character', chat)
        const result = await versioning.checkout({
            characterId: 'character',
            chatId: chat,
            commitId: head!,
            reason: 'truncate',
        })
        // The rewind reports that it captured the on-disk edit, and the edit
        // stays recoverable instead of being silently overwritten.
        expect(result.preservedExternalCommitId).toBeTruthy()
        const recovery = await versioning.listRefs({
            characterId: 'character',
            chatId: chat,
            kind: 'recovery',
        })
        expect(recovery.map((ref) => ref.commitId))
            .toContain(result.preservedExternalCommitId)
        const preserved = await versioning.readPathMap(
            'character', chat, result.preservedExternalCommitId!
        )
        const path = Object.keys(preserved)
            .find((candidate) => candidate.includes('concepts/'))
        expect(path).toBeTruthy()
    })

    test('fork shares history so branches stay independent', async () => {
        const root = await createRoot()
        const versioning = createWikiVersioning(root)
        const wiki = createMarkdownNarrativeWiki(root, { versioning })

        const base = await wiki.saveCanonicalDocument({
            characterId: 'character',
            chatId: chat,
            type: 'location',
            title: 'Keep',
            sourceMessageIds: ['assistant-1'],
            markdown: '# Keep\n\n## State\n\n- Quiet.',
            chatAnchor: anchorAt('assistant-1'),
        })
        const forked = await versioning.fork({
            characterId: 'character',
            sourceChatId: chat,
            destinationChatId: 'chat-branch',
            commitId: base.vcsCommitId!,
        })
        expect(forked.commitId).toBe(base.vcsCommitId)

        // Both chats resolve the same document content from one shared blob.
        const sourcePaths = await versioning.readPathMap(
            'character', chat, base.vcsCommitId!
        )
        const branchPaths = await versioning.readPathMap(
            'character', 'chat-branch', forked.commitId
        )
        expect(branchPaths).toEqual(sourcePaths)
    })

    test('reference saves load without copying the wiki tree', async () => {
        const root = await createRoot()
        const versioning = createWikiVersioning(root)
        const wiki = createMarkdownNarrativeWiki(root, { versioning })
        const repository = createWikiVcsRepository(root)

        const saved = await wiki.saveCanonicalDocument({
            characterId: 'character',
            chatId: chat,
            type: 'other',
            title: 'Notes',
            sourceMessageIds: ['assistant-1'],
            markdown: '# Notes\n\n## Body\n\n- Recorded.',
        })
        const chatBytes = Buffer.from('encoded chat state')
        const chatHash = await repository.storeChatState({
            characterId: 'character',
            chatId: chat,
            contents: chatBytes.toString('base64'),
        })
        await writeMemorySaveReference({
            userDataDirectory: root,
            characterId: 'character',
            sourceChatId: chat,
            saveId: 'autosave-1',
            sourceChatName: 'Long chat',
            turnCount: 12,
            chatStateRef: chatHash,
            wikiCommitId: saved.vcsCommitId,
        })

        const record = await readMemorySaveReference({
            userDataDirectory: root,
            characterId: 'character',
            saveId: 'autosave-1',
        })
        expect(record).toMatchObject({
            mode: 'commit-reference',
            turnCount: 12,
            wikiCommitId: saved.vcsCommitId,
        })
        // The wiki tree is referenced, never copied into the save slot.
        await expect(fs.access(join(
            root, 'risubard', 'characters',
            `id-${Buffer.from('character', 'utf8').toString('base64url')}`,
            'chats',
            `id-${Buffer.from(memorySaveWorkspaceId('autosave-1'), 'utf8')
                .toString('base64url')}`,
            'wiki'
        ))).rejects.toMatchObject({ code: 'ENOENT' })

        const stored = await repository.readChatState({
            characterId: 'character',
            chatId: chat,
            hash: chatHash,
        })
        expect(stored).toBe(chatBytes.toString('base64'))
    })

    test('unchanged chat state costs no additional storage', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        const contents = Buffer.from('same bytes').toString('base64')
        const first = await repository.storeChatState({
            characterId: 'character', chatId: chat, contents,
        })
        const second = await repository.storeChatState({
            characterId: 'character', chatId: chat, contents,
        })
        expect(second).toBe(first)
    })

    test('one analysis publishes its events and documents as a single commit', async () => {
        const root = await createRoot()
        const versioning = createWikiVersioning(root)
        const wiki = createMarkdownNarrativeWiki(root, { versioning })

        await wiki.beginWriteBatch({
            characterId: 'character',
            chatId: chat,
            operationId: 'analysis-1',
            kind: 'analysis',
            chatAnchor: anchorAt('assistant-1'),
        })
        await wiki.saveConfirmedTurn({
            characterId: 'character',
            chatId: chat,
            operationId: 'analysis-1',
            sourceMessageIds: ['assistant-1'],
            markdown: '## The gate opened\n\n### Story\n\n- It opened.',
        })
        await wiki.saveCanonicalDocument({
            characterId: 'character',
            chatId: chat,
            operationId: 'analysis-1',
            type: 'character',
            title: 'Aria',
            sourceMessageIds: ['assistant-1'],
            markdown: '# Aria\n\n## Current state\n\n- At the gate.',
        })
        await wiki.saveCanonicalDocument({
            characterId: 'character',
            chatId: chat,
            operationId: 'analysis-1',
            type: 'location',
            title: 'Gate',
            sourceMessageIds: ['assistant-1'],
            markdown: '# Gate\n\n## State\n\n- Open.',
        })

        // Only the baseline is visible while analysis is staged.
        expect((await versioning.listHistory({
            characterId: 'character', chatId: chat,
        })).map((entry) => entry.kind)).toEqual(['baseline'])
        expect((await wiki.loadView('character', chat)).documents).toEqual([])

        const published = await wiki.publishWriteBatch({
            characterId: 'character',
            chatId: chat,
            operationId: 'analysis-1',
        })
        expect(published.commitId).toMatch(/^[a-f0-9]{64}$/)
        // The commit covers every file the operation wrote.
        expect(published.changedPaths).toHaveLength(3)

        const history = await versioning.listHistory({
            characterId: 'character', chatId: chat,
        })
        expect(history.map((entry) => entry.kind)).toEqual(['analysis', 'baseline'])
        expect(history[0].kind).toBe('analysis')
        // Checking out at that boundary restores all three documents together.
        const paths = await versioning.readPathMap(
            'character', chat, published.commitId!
        )
        expect(Object.keys(paths)).toHaveLength(3)
    })

    test('an abandoned batch publishes nothing', async () => {
        const root = await createRoot()
        const versioning = createWikiVersioning(root)
        const wiki = createMarkdownNarrativeWiki(root, { versioning })

        await wiki.beginWriteBatch({
            characterId: 'character',
            chatId: chat,
            operationId: 'analysis-empty',
            kind: 'analysis',
        })
        await wiki.abandonWriteBatch({
            characterId: 'character', chatId: chat,
            operationId: 'analysis-empty',
        })
        // Once abandoned, writes commit normally instead of being swallowed.
        const saved = await wiki.saveManualDocument({
            characterId: 'character',
            chatId: chat,
            type: 'concept',
            title: 'After',
            markdown: '# After\n\n## Body\n\n- Written.',
        })
        expect(saved.vcsCommitId).toMatch(/^[a-f0-9]{64}$/)
    })

    test('finishes a commit interrupted after its journal was prepared', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        const versioning = createWikiVersioning(root)
        const wiki = createMarkdownNarrativeWiki(root, { versioning })

        await wiki.saveManualDocument({
            characterId: 'character',
            chatId: chat,
            type: 'concept',
            title: 'First',
            markdown: '# First\n\n## Body\n\n- One.',
        })
        const headBefore = (await versioning.ensureBaseline({
            characterId: 'character',
            chatId: chat,
        })).commitId

        // Simulate the crash window: the commit record and its journal exist,
        // but the branch head was never moved.
        const repositoryRoot = resolveWikiVcsRepository(root, 'character', chat)
        const operationId = 'interrupted:1'
        const commitPayload = {
            schemaVersion: 1 as const,
            parent: headBefore,
            operationId,
            kind: 'manual' as const,
            changes: [] as never[],
            chatAnchor: anchorAt('assistant-1'),
            provenance: 'recorded' as const,
            createdAt: new Date().toISOString(),
        }
        const contents = '# Interrupted\n\n## Body\n\n- Written before the crash.'
        const blobHash = createHash('sha256').update(contents).digest('hex')
        const objectTarget = join(
            repositoryRoot.objectsDirectory,
            blobHash.slice(0, 2), blobHash
        )
        await fs.mkdir(join(repositoryRoot.objectsDirectory, blobHash.slice(0, 2)), {
            recursive: true,
        })
        await fs.writeFile(objectTarget, contents)
        const interrupted = {
            ...commitPayload,
            changes: [{ path: 'concepts/Interrupted.md', before: null, after: blobHash }],
        }
        const commitId = createHash('sha256')
            .update(JSON.stringify(interrupted)).digest('hex')
        await fs.mkdir(join(repositoryRoot.commitsDirectory), { recursive: true })
        await fs.writeFile(
            join(repositoryRoot.commitsDirectory, `${commitId}.json`),
            JSON.stringify({ ...interrupted, id: commitId })
        )
        await fs.mkdir(join(repositoryRoot.operationsDirectory, operationId), {
            recursive: true,
        })
        await fs.writeFile(
            join(repositoryRoot.operationsDirectory, operationId, 'journal.json'),
            JSON.stringify({
                schemaVersion: 1,
                operationId,
                characterId: 'character',
                chatId: chat,
                branchId: `branch:${chat}`,
                previousHead: headBefore,
                commitId,
                changedPaths: ['concepts/Interrupted.md'],
                checkpointCreated: false,
                prepared: true,
                published: false,
                createdAt: new Date().toISOString(),
            })
        )

        const recovered = await repository.recoverOperations({
            characterId: 'character',
            chatId: chat,
        })
        expect(recovered.completed).toEqual([operationId])
        expect(recovered.unresolved).toEqual([])

        // The interrupted commit is now the head and its document is readable.
        const head = await versioning.readHead('character', chat)
        expect(head).toBe(commitId)
        const paths = await repository.readPathMap('character', chat, commitId)
        expect(paths['concepts/Interrupted.md']).toBe(blobHash)

        // Recovery is idempotent: the completed operation is not replayed and
        // the head stays where the first pass put it.
        const again = await repository.recoverOperations({
            characterId: 'character',
            chatId: chat,
        })
        expect(again).toEqual({
            completed: [],
            discarded: [],
            unresolved: [],
        })
        expect(await versioning.readHead('character', chat)).toBe(commitId)
        expect(await repository.listHistory({
            characterId: 'character', chatId: chat,
        })).toHaveLength(2)
    })

    test('discards an operation that never reached its commit record', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await repository.ensureRepository('character', chat)
        const repositoryRoot = resolveWikiVcsRepository(root, 'character', chat)
        const operationId = 'interrupted:unprepared'
        await fs.mkdir(join(repositoryRoot.operationsDirectory, operationId), {
            recursive: true,
        })
        await fs.writeFile(
            join(repositoryRoot.operationsDirectory, operationId, 'journal.json'),
            JSON.stringify({
                schemaVersion: 1,
                operationId,
                characterId: 'character',
                chatId: chat,
                branchId: `branch:${chat}`,
                previousHead: null,
                commitId: 'a'.repeat(64),
                changedPaths: [],
                checkpointCreated: false,
                prepared: false,
                published: false,
                createdAt: new Date().toISOString(),
            })
        )
        const recovered = await repository.recoverOperations({
            characterId: 'character',
            chatId: chat,
        })
        expect(recovered.discarded).toEqual([operationId])
        expect(recovered.completed).toEqual([])
        // No history was invented from an unconfirmed operation.
        expect(await repository.listHistory({
            characterId: 'character', chatId: chat,
        })).toHaveLength(0)
    })
})

describe('staged publication conflicts', () => {
    test.each(['chat', 'head'] as const)('preserves live Wiki when another client changes %s', async (conflict) => {
        const root = await createRoot()
        let currentAnchor = anchorAt('assistant-1')
        const versioning = createWikiVersioning(root, {
            loadChatAnchor: async () => currentAnchor,
        })
        const wiki = createMarkdownNarrativeWiki(root, { versioning })
        await versioning.ensureBaseline({ characterId: 'character', chatId: chat })
        const original = await wiki.saveManualDocument({
            characterId: 'character', chatId: chat, type: 'concept',
            title: 'Clock', markdown: '# Clock\n\n## State\n\n- Original.',
        })
        const workspace = resolveWikiVcsRepository(root, 'character', chat)
        const file = join(workspace.workingTreeDirectory, original.relativePath)
        const originalBytes = await fs.readFile(file, 'utf8')
        await wiki.beginWriteBatch({
            characterId: 'character', chatId: chat,
            operationId: 'analysis-stale', kind: 'analysis', chatAnchor: currentAnchor,
        })
        await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: chat,
            operationId: 'analysis-stale', type: 'concept',
            title: 'Clock', sourceMessageIds: ['assistant-1'],
            markdown: '# Clock\n\n## State\n\n- Staged.',
        })
        await expect(wiki.saveConfirmedTurn({
            characterId: 'character', chatId: chat, operationId: 'another-client',
            sourceMessageIds: ['assistant-1'], markdown: '## Another\n\n- Turn.',
        })).rejects.toThrow('owned by another operation')
        expect(await fs.readFile(file, 'utf8')).toBe(originalBytes)
        let liveBytes = originalBytes
        if (conflict === 'chat') currentAnchor = anchorAt('assistant-edited')
        else {
            liveBytes = originalBytes.replace('Original.', 'Another client.')
            await fs.writeFile(file, liveBytes)
            await versioning.captureExternalChanges({ characterId: 'character', chatId: chat })
        }
        await expect(wiki.publishWriteBatch({
            characterId: 'character', chatId: chat, operationId: 'analysis-stale',
        })).rejects.toThrow(`Wiki ${conflict === 'chat' ? 'chat' : 'commit'} conflict`)
        expect(await fs.readFile(file, 'utf8')).toBe(liveBytes)
        expect((await versioning.listHistory({
            characterId: 'character', chatId: chat,
        })).some((entry) => entry.kind === 'analysis')).toBe(false)
    })
})

describe('chat-prefix restoration over HTTP', () => {
    test('restores the prior state with a trailing user, rejects missing confirmed checkpoints and changed evidence', async () => {
        const root = await createRoot()
        const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
        const { registerRisuBardMemoryRoutes, createRisuBardMemoryJsonParser } = require('./risubard-memory-routes.cjs')
        const express = require('express')
        const messages: WikiAnchorMessage[] = []
        const service = createRuntimeMemoryService(root, {
            loadChatAnchor: async (_characterId: string, chatId: string) =>
                chatBoundaryAnchor(chatId, messages.at(-1)?.messageId ?? null, messages),
            validateChatAnchor: (expected: WikiChatAnchor) => {
                const index = messages.findIndex((message) => message.messageId === expected.boundaryMessageId)
                return chatBoundaryAnchor(expected.sourceChatId, expected.boundaryMessageId,
                    messages.slice(0, index + 1)).prefixDigest === expected.prefixDigest
            },
        })
        const app = express()
        app.use(createRisuBardMemoryJsonParser(express))
        registerRisuBardMemoryRoutes(app, { auth: async () => true, service })
        const ready = Promise.withResolvers<void>()
        const server: Server = app.listen(0, '127.0.0.1', ready.resolve)
        server.once('error', ready.reject)
        await ready.promise
        try {
            const address = server.address()
            if (!address || typeof address === 'string') throw new Error('HTTP address unavailable')
            const transport = {
                characterId: 'character', chatId: chat,
                fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) =>
                    fetch(`http://127.0.0.1:${address.port}${url}`, init)) as typeof fetch,
                createAuth: async () => '',
            }
            await service.ensureWikiVersion(transport)
            messages.push({ messageId: 'a1', role: 'assistant', data: 'Alice has no sword.' })
            const document = await service.saveManualWikiDocument({
                ...transport, type: 'character', title: 'Alice',
                markdown: '## Alice\n\nAlice has no sword.',
            })
            const first = (await service.wikiHistory(transport))[0].commitId
            messages.push({ messageId: 'u2', role: 'user', data: 'Find a sword.' })
            const remaining = messages.slice()
            messages.push({ messageId: 'a2', role: 'assistant', data: 'Alice finds a sword.' })
            await service.saveManualWikiDocument({
                ...transport, documentId: document.id, type: 'character', title: 'Alice',
                markdown: '## Alice\n\nAlice has the future sword.',
            })
            const compatible = await findWikiCommitForPrefix({
                ...transport, messages: remaining, minimumBoundaryMessageId: 'a1',
            })
            expect(compatible).toBe(first)
            const preview = await previewWikiCheckout({
                ...transport, commitId: first, messages: remaining,
            })
            expect(preview.exact).toBe(true)
            expect(preview.chatAnchor.boundaryMessageId).toBe('a1')
            const edited = remaining.map((message) =>
                message.messageId === 'a1' ? { ...message, data: 'Alice already has a sword.' } : message)
            expect(await findWikiCommitForPrefix({
                ...transport, messages: edited, minimumBoundaryMessageId: 'a1',
            })).toBeNull()
            expect((await previewWikiCheckout({
                ...transport, commitId: first, messages: edited,
            })).exact).toBe(false)
            const withoutCheckpoint = [...remaining,
                { messageId: 'a-missing', role: 'assistant', data: 'A confirmed batch interior.' }]
            expect(await findWikiCommitForPrefix({
                ...transport, messages: withoutCheckpoint, minimumBoundaryMessageId: 'a-missing',
            })).toBeNull()
            const longPrefix = [...remaining, ...Array.from({ length: 10_000 }, (_, index) => ({
                messageId: `pending-user-${index}`, role: 'user',
                data: 'Long unconfirmed conversation context. '.repeat(100),
            }))]
            expect(await findWikiCommitForPrefix({
                ...transport, messages: longPrefix, minimumBoundaryMessageId: 'a1',
            })).toBe(first)
            await checkoutWikiVersion({ ...transport, commitId: compatible!, reason: 'reroll' })
            const restored = await service.loadView('character', chat)
            expect(restored.documents.find((item: { id: string }) => item.id === document.id)?.content)
                .toContain('Alice has no sword.')
            expect(restored.documents.find((item: { id: string }) => item.id === document.id)?.content)
                .not.toContain('future sword')
        }
        finally {
            const closed = Promise.withResolvers<void>()
            server.close((error) => error ? closed.reject(error) : closed.resolve())
            await closed.promise
        }
    })
})
