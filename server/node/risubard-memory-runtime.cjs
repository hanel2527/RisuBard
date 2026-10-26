require('sucrase/register/ts')

const {
    createNarrativeMemoryService,
} = require('./risubard-memory-service.ts')
const {
    createSourceSnapshotAdapter,
} = require('./risubard-source-workspace.ts')
const {
    createNarrativeGraphService,
} = require('./risubard-graph-service.ts')
const {
    createMarkdownNarrativeWiki,
} = require('./risubard-markdown-wiki.ts')
const {
    completeMemoryWorkspaceFork,
    forkMemoryWorkspace,
    removeRebootMemoryWorkspace,
    replaceMemoryWorkspace,
} = require('./risubard-memory-fork.ts')
const {
    createMemorySaveSlot,
    deleteMemorySaveSlot,
    listMemorySaveSlots,
    memorySaveWorkspaceId,
    prepareMemorySaveLoad,
    readMemorySaveChat,
    renameMemorySaveSlot,
} = require('./risubard-memory-save.ts')
const { revealLocalFile } = require('./reveal-local-file.cjs')
const { inheritWikiWorkspace, importWikiWorkspace } = require('./risubard-wiki-transfer.ts')
const { createStoryHistoryService } = require('./risubard-story-history.ts')
const { createStoryHistoryMigration } = require('./risubard-story-history-migration.ts')

function createRuntimeMemoryService(userDataDirectory, options = {}) {
    const memory = createNarrativeMemoryService(userDataDirectory)
    const sources = createSourceSnapshotAdapter(userDataDirectory)
    const graph = createNarrativeGraphService(userDataDirectory, {
        loadV1State: (characterId, chatId) =>
            memory.loadState(characterId, chatId),
        applyV1Delta: (input) => memory.applyDelta(input),
    })
    const wiki = createMarkdownNarrativeWiki(userDataDirectory)
    const revealFile = options.revealFile || revealLocalFile
    const forkWorkspace = options.forkWorkspace || forkMemoryWorkspace
    const completeForkWorkspace = options.completeForkWorkspace
        || completeMemoryWorkspaceFork
    const replaceWorkspace = options.replaceWorkspace || replaceMemoryWorkspace
    const removeRebootWorkspace = options.removeRebootWorkspace
        || removeRebootMemoryWorkspace
    const createSaveSlot = options.createSaveSlot || createMemorySaveSlot
    const listSaveSlots = options.listSaveSlots || listMemorySaveSlots
    const prepareSaveLoad = options.prepareSaveLoad || prepareMemorySaveLoad
    const previewSaveSlot = options.previewSaveSlot || readMemorySaveChat
    const renameSaveSlot = options.renameSaveSlot || renameMemorySaveSlot
    const deleteSaveSlot = options.deleteSaveSlot || deleteMemorySaveSlot
    const history = options.history || createStoryHistoryService(userDataDirectory)
    const migration = options.migration || createStoryHistoryMigration(userDataDirectory, history, {
        persistChat: async (input) => {
            if (!options.persistStoryChat) throw new Error('Canonical story chat writer is unavailable')
            await options.persistStoryChat(input)
        },
    })
    const conflict = (message) => Object.assign(new Error(message), {
        status: 409, code: 'STORY_HISTORY_CONFLICT',
    })
    const persistCheckout = async (prepared, characterId) => {
        if (typeof options.persistStoryChat !== 'function') {
            throw new Error('Canonical story chat writer is unavailable')
        }
        await options.persistStoryChat({
            characterId,
            chatId: prepared.destinationChatId,
            sourceChatId: prepared.sourceChatId,
            chat: prepared.chat,
        })
        const state = await history.completeCheckout({
            characterId,
            chatId: prepared.destinationChatId,
            forkToken: prepared.forkToken,
            action: 'finalize',
        })
        wiki.invalidateCache(characterId, prepared.destinationChatId)
        return { ...prepared, state }
    }
    // The core pending record is published before wiki replacement. It is the
    // recovery journal for both canonical chat persistence and reference publication.
    let recoveryNeeded = true
    let recovering = null
    const recoverCheckouts = () => {
        if (!recoveryNeeded) return Promise.resolve()
        if (recovering) return recovering
        recovering = (async () => {
            for (const scope of await history.listPendingCheckouts()) {
                const prepared = await history.recoverCheckout(scope)
                if (prepared) await persistCheckout(prepared, scope.characterId)
            }
            recoveryNeeded = false
        })().finally(() => { recovering = null })
        return recovering
    }
    const storageOperation = (operation) => {
        const run = async () => {
            await recoverCheckouts()
            return operation()
        }
        return options.storageGate ? options.storageGate(run) : run()
    }
    const assertLegacy = async (characterId, chatId) => {
        if ((await history.status({ characterId, chatId })).mode === 'history') {
            throw conflict('This chat uses story history; legacy slot writes and loads are disabled')
        }
    }
    const manualWiki = async (input, operation, reason) => {
        await history.assertWritable(input)
        const result = await operation()
        if (!input.chatId.startsWith('reboot-')) {
            await history.commitManualWiki({
                characterId: input.characterId, chatId: input.chatId, reason,
            })
        }
        return result
    }
    const canonicalWiki = async (input, operation, reason) => {
        const state = await history.status(input)
        if (input.historyOperationId && state.pendingWiki?.operationId !== input.historyOperationId) {
            throw conflict('The wiki history operation is no longer active')
        }
        await history.assertWritable(input, { operationId: input.historyOperationId })
        const result = await operation()
        // Automatic analysis publishes once in finishWiki, never per document.
        if (!state.pendingWiki && !input.chatId.startsWith('reboot-')) {
            await history.commitManualWiki({
                characterId: input.characterId, chatId: input.chatId, reason,
            })
        }
        return result
    }
    // Per-workspace reader/writer lanes: a write waits for every earlier
    // operation; a read waits only for earlier writes, so views and save
    // copies of the same chat do not queue behind each other.
    const queues = new Map()
    // Saves of one character share a page store; releasing unused pages must
    // not race another save that is still adding pages.
    const SAVE_STORE_LANE = '\u0000save-store'
    const scheduled = (readPairs, writePairs, operation) => {
        const keyOf = (pair) => JSON.stringify(pair)
        const writeKeys = [...new Set(writePairs.map(keyOf))].sort()
        const readKeys = [...new Set(readPairs.map(keyOf))]
            .filter((key) => !writeKeys.includes(key)).sort()
        const laneFor = (key) => {
            let lane = queues.get(key)
            if (!lane) {
                lane = { write: null, reads: new Set() }
                queues.set(key, lane)
            }
            return lane
        }
        const previous = []
        for (const key of writeKeys) {
            const lane = laneFor(key)
            if (lane.write) previous.push(lane.write)
            previous.push(...lane.reads)
        }
        for (const key of readKeys) {
            const lane = laneFor(key)
            if (lane.write) previous.push(lane.write)
        }
        const current = Promise.all(previous).then(() => storageOperation(operation))
        const settled = current.then(() => undefined, () => undefined)
        for (const key of writeKeys) {
            const lane = laneFor(key)
            lane.write = settled
            lane.reads = new Set()
        }
        for (const key of readKeys) laneFor(key).reads.add(settled)
        settled.then(() => {
            for (const key of [...writeKeys, ...readKeys]) {
                const lane = queues.get(key)
                if (!lane) continue
                lane.reads.delete(settled)
                if (lane.write === settled) lane.write = null
                if (!lane.write && lane.reads.size === 0) queues.delete(key)
            }
        })
        return current
    }
    const serializedMany = (pairs, operation) => scheduled([], pairs, operation)
    const serialized = (characterId, chatId, operation) => serializedMany(
        [[characterId, chatId], [characterId, SAVE_STORE_LANE]],
        operation
    )
    const readSerialized = (characterId, chatId, operation) => scheduled(
        [[characterId, chatId]],
        [],
        operation
    )
    return {
        ...memory,
        loadState: (characterId, chatId) => readSerialized(characterId, chatId,
            () => memory.loadState(characterId, chatId)),
        recoverStoryCheckouts: (input = {}) => {
            if (input.reload) recoveryNeeded = true
            if (input.withinStorageGate) return recoverCheckouts()
            // Recovery needs the storage exclusion lane, not permission for a
            // new user mutation. Merely inspecting an empty journal must not
            // block startup when external files await review.
            const gate = options.recoveryGate || options.storageGate
            return gate ? gate(recoverCheckouts) : recoverCheckouts()
        },
        storyHistoryStatus: (input) => serialized(input.characterId, input.chatId, async () => {
            const state = await history.status(input)
            if (state.pendingWiki && state.pendingWiki.status !== 'writing') {
                wiki.invalidateCache(input.characterId, input.chatId)
            }
            return state
        }),
        previewStoryHistory: (input) => serialized(input.characterId, input.chatId,
            () => history.preview(input)),
        captureStoryHistory: (input) => serialized(input.characterId, input.chatId,
            () => history.capture(input)),
        beginStoryWiki: (input) => serialized(input.characterId, input.chatId, async () => {
            try { return await history.beginWiki(input) }
            finally { wiki.invalidateCache(input.characterId, input.chatId) }
        }),
        finishStoryWiki: (input) => serialized(input.characterId, input.chatId, async () => {
            try { return await history.finishWiki(input) }
            finally { wiki.invalidateCache(input.characterId, input.chatId) }
        }),
        checkoutStoryHistory: (input) => serializedMany([
            [input.characterId, input.chatId],
            [input.characterId, input.destinationChatId || input.chatId],
            [input.characterId, SAVE_STORE_LANE],
        ], async () => {
            recoveryNeeded = true
            const prepared = await history.prepareCheckout(input)
            const result = await persistCheckout(prepared, input.characterId)
            recoveryNeeded = false
            return result
        }),
        completeStoryCheckout: (input) => serializedMany([
            [input.characterId, input.chatId],
            [input.characterId, input.destinationChatId || input.chatId],
            [input.characterId, SAVE_STORE_LANE],
        ], () => {
            // HTTP checkout already publishes durably. A late browser discard
            // cannot roll canonical data back after the server committed it.
            if (input.action === 'discard') {
                throw conflict('Story checkout is already durable and cannot be discarded')
            }
            return history.completeCheckout(input)
        }),
        renameStoryHistory: (input) => serialized(input.characterId, input.chatId,
            () => history.rename(input)),
        quickStoryHistory: (input) => serialized(input.characterId, input.chatId,
            () => history.setQuick(input)),
        migrateStoryHistory: (input) => serialized(input.characterId, input.chatId,
            () => migration.migrate(input)),
        rollbackStoryHistory: (input) => serialized(input.characterId, input.chatId,
            async () => {
                await history.assertWritable(input)
                return migration.rollback(input)
            }),
        inheritWiki: (input) => serializedMany([
            [input.characterId, input.sourceChatId],
            [input.characterId, input.destinationChatId],
        ], () => manualWiki({
            characterId: input.characterId, chatId: input.destinationChatId,
        }, () => inheritWikiWorkspace({ userDataDirectory, ...input }), 'wiki-inherit')),
        importWiki: (input) => serialized(input.characterId, input.chatId, async () => {
            try {
                return await manualWiki(input,
                    () => importWikiWorkspace({ userDataDirectory, ...input }), 'wiki-import')
            }
            finally { wiki.invalidateCache(input.characterId, input.chatId) }
        }),
        applyDelta: (input) => serialized(
            input.characterId,
            input.chatId,
            () => memory.applyDelta(input)
        ),
        forkMemory: (input) => serializedMany([
            [input.characterId, input.sourceChatId],
            [input.destinationCharacterId || input.characterId,
                input.destinationChatId],
        ], async () => {
            await history.assertWritable({
                characterId: input.destinationCharacterId || input.characterId,
                chatId: input.destinationChatId,
            })
            return forkWorkspace({ userDataDirectory, ...input })
        }),
        replaceMemory: (input) => serializedMany([
            [input.characterId, input.sourceChatId],
            [input.characterId, input.destinationChatId],
        ], async () => {
            await history.assertWritable({
                characterId: input.characterId, chatId: input.destinationChatId,
            })
            return replaceWorkspace({ userDataDirectory, ...input })
        }),
        removeRebootMemory: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => {
                const removed = await removeRebootWorkspace({
                    userDataDirectory,
                    ...input,
                })
                wiki.invalidateCache(input.characterId, input.chatId)
                return removed
            }
        ),
        completeMemoryFork: (input) => serialized(
            input.characterId,
            input.destinationChatId,
            async () => {
                await history.assertWritable({
                    characterId: input.characterId, chatId: input.destinationChatId,
                })
                const completed = await completeForkWorkspace({
                    userDataDirectory,
                    ...input,
                })
                wiki.invalidateCache(
                    input.characterId,
                    input.destinationChatId
                )
                if (input.action === 'finalize' && !input.destinationChatId.startsWith('reboot-')) {
                    await history.commitManualWiki({
                        characterId: input.characterId, chatId: input.destinationChatId,
                        reason: 'workspace-replacement', operationId: `workspace:${input.forkToken}`,
                    })
                }
                return completed
            }
        ),
        createMemorySave: (input) => scheduled([
            [input.characterId, input.sourceChatId],
        ], [
            [input.characterId, memorySaveWorkspaceId(input.saveId)],
            [input.characterId, SAVE_STORE_LANE],
        ], async () => {
            await assertLegacy(input.characterId, input.sourceChatId)
            const latest = await wiki.latestActiveEvent(
                input.characterId,
                input.sourceChatId
            )
            const excerpt = latest?.content
                .replace(/^#\s+[^\r\n]+\r?\n*/, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 500)
            return createSaveSlot({
                userDataDirectory,
                ...input,
                ...(latest ? {
                    latestEvent: {
                        title: latest.title,
                        excerpt: excerpt || latest.title,
                    },
                } : {}),
            })
        }),
        listMemorySaves: (input) => serialized(input.characterId, input.sourceChatId,
            () => listSaveSlots({ userDataDirectory, ...input })),
        previewMemorySave: (input) => serialized(
            input.characterId,
            memorySaveWorkspaceId(input.saveId),
            () => previewSaveSlot({ userDataDirectory, ...input })
        ),
        renameMemorySave: (input) => serialized(
            input.characterId,
            memorySaveWorkspaceId(input.saveId),
            () => renameSaveSlot({ userDataDirectory, ...input })
        ),
        deleteMemorySave: (input) => serializedMany([
            [input.characterId, memorySaveWorkspaceId(input.saveId)],
            [input.characterId, SAVE_STORE_LANE],
        ], () => deleteSaveSlot({ userDataDirectory, ...input })),
        prepareMemorySaveLoad: (input) => serializedMany([
            [input.characterId, memorySaveWorkspaceId(input.saveId)],
            [input.characterId, input.destinationChatId],
            [input.characterId, SAVE_STORE_LANE],
        ], async () => {
            await assertLegacy(input.characterId, input.destinationChatId)
            return prepareSaveLoad({ userDataDirectory, ...input })
        }),
        loadGraphState: (characterId, chatId) => readSerialized(characterId, chatId,
            () => graph.loadState(characterId, chatId)),
        applyGraphDelta: (input) => serialized(
            input.characterId,
            input.chatId,
            () => graph.applyDelta(input)
        ),
        reconcileGraphV1: (characterId, chatId) => serialized(
            characterId,
            chatId,
            () => graph.reconcileV1(characterId, chatId)
        ),
        hydrateGraphIndex: (characterId, chatId) => serialized(
            characterId,
            chatId,
            () => graph.hydrateIndex(characterId, chatId)
        ),
        readGraphForInquiry: (characterId, chatId) => readSerialized(characterId, chatId,
            () => graph.readForInquiry(characterId, chatId)),
        inquireNarrative: (input) => readSerialized(input.characterId, input.chatId,
            () => wiki.inquire(input)),
        embeddingCatalog: (input) => readSerialized(input.characterId, input.chatId,
            () => wiki.embeddingCatalog(input)),
        saveMarkdownWikiTurn: (input) => serialized(
            input.characterId,
            input.chatId,
            () => canonicalWiki(input, () => wiki.saveConfirmedTurn(input), 'wiki-turn')
        ),
        saveCanonicalWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            () => canonicalWiki(input, () => wiki.saveCanonicalDocument(input), 'wiki-document')
        ),
        reviewCanonicalWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            () => canonicalWiki(input, () => wiki.reviewCanonicalDocument(input), 'wiki-review')
        ),
        beginBardChatUndo: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.beginBardChatUndo(input)
        ),
        finalizeBardChatUndo: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.finalizeBardChatUndo(input)
        ),
        getBardChatUndoStatus: (input) => readSerialized(
            input.characterId,
            input.chatId,
            () => wiki.getBardChatUndoStatus(input)
        ),
        restoreBardChatUndo: (input) => serialized(
            input.characterId,
            input.chatId,
            () => manualWiki(input, () => wiki.restoreBardChatUndo(input), 'bardchat-undo')
        ),
        saveManualWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            () => manualWiki(input, () => wiki.saveManualDocument(input), 'manual-document')
        ),
        replaceWikiText: (input) => serialized(
            input.characterId,
            input.chatId,
            () => manualWiki(input, () => wiki.replaceAllText(input), 'replace-text')
        ),
        setWikiDocumentContextMode: (input) => serialized(
            input.characterId,
            input.chatId,
            () => manualWiki(input, () => wiki.setDocumentContextMode(input), 'context-mode')
        ),
        setWikiDocumentGrade: (input) => serialized(
            input.characterId,
            input.chatId,
            () => manualWiki(input, () => wiki.setDocumentGrade(input), 'document-grade')
        ),
        trashWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            () => manualWiki(input, () => wiki.trashDocument(input), 'trash-document')
        ),
        retractWikiEvent: (input) => serialized(
            input.characterId,
            input.chatId,
            () => manualWiki(input, () => wiki.retractEvent(input), 'retract-event')
        ),
        retractWikiEventsBySourceMessages: (input) => serialized(
            input.characterId,
            input.chatId,
            () => manualWiki(input, () => wiki.retractEventsBySourceMessages(input), 'retract-events')
        ),
        revealWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => {
                revealFile(await wiki.resolveDocumentFile(input))
                return { ok: true }
            }
        ),
        beginWikiRebootBatch: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.beginRebootBatch(input)
        ),
        recordWikiRebootBatch: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.recordRebootBatchReceipt(input)
        ),
        recoverWikiRebootBatch: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => ({ receipt: await wiki.recoverRebootBatch(input) })
        ),
        completeWikiRebootBatch: (input) => serialized(
            input.characterId,
            input.chatId,
            () => manualWiki(input, () => wiki.completeRebootBatch(input), 'wiki-reboot')
        ),
        recordGraphAnalysis: (characterId, chatId, result) => serialized(
            characterId,
            chatId,
            () => graph.recordAnalysis(characterId, chatId, result)
        ),
        async applyWriterCommand(input) {
            return serialized(input.characterId, input.chatId, async () => {
                await history.assertWritable(input)
                const snapshot = structuredClone(input)
                try {
                    return await graph.applyWriterCommand(snapshot)
                }
                catch (error) {
                    if (!(error instanceof Error)
                        || error.message
                            !== 'Writer graph persistence failed') {
                        throw error
                    }
                    try {
                        await graph.reconcileV1(
                            snapshot.characterId,
                            snapshot.chatId
                        )
                    }
                    catch {
                        // Dirty graph fallback remains authoritative.
                    }
                    throw error
                }
            })
        },
        loadCatalog: (characterId, chatId) => readSerialized(characterId, chatId,
            () => wiki.loadCatalog(characterId, chatId)),
        readDocumentBodies: (characterId, chatId, documentIds) => readSerialized(characterId, chatId,
            () => wiki.readDocumentBodies(characterId, chatId, documentIds)),
        searchDocumentIds: (characterId, chatId, query) => readSerialized(characterId, chatId,
            () => wiki.searchDocumentIds(characterId, chatId, query)),
        storySummaries: (characterId, chatId) => readSerialized(characterId, chatId,
            () => wiki.storySummaries(characterId, chatId)),
        warmWiki: (characterId, chatId) => readSerialized(characterId, chatId,
            () => wiki.warm(characterId, chatId)),
        async loadView(characterId, chatId) {
            return readSerialized(characterId, chatId, async () => {
                return wiki.loadView(characterId, chatId)
            })
        },
        async ensureSourceSnapshot(characterId, chatId, snapshot) {
            return serialized(characterId, chatId, async () => {
                const stored = await sources.loadSnapshot(characterId, chatId)
                const selected = stored
                    || await sources.saveSnapshot(characterId, chatId, snapshot)
                return {
                    snapshot: selected,
                    baseline: await sources.loadBaseline(characterId, chatId),
                }
            })
        },
        async saveSourceBaseline(characterId, chatId, summary) {
            return serialized(characterId, chatId, async () => {
                const existing = await sources.loadBaseline(characterId, chatId)
                return existing
                    || sources.saveBaseline(characterId, chatId, summary)
            })
        },
    }
}

module.exports = {
    createRuntimeMemoryService,
}
