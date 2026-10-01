require('sucrase/register/ts')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const { watch, realpathSync } = require('node:fs')
const { dirname, join, relative } = require('node:path')
const { Packr, Unpackr } = require('msgpackr')
const { createUserDataRepository } = require('./user-data-repository.cjs')
const chatPacker = new Packr({ useRecords: false })
const chatUnpacker = new Unpackr({ useRecords: false, int64AsType: 'number' })
const { resolveMemoryWorkspace } = require('./risubard-memory-workspace.ts')


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
    createWikiVersioning,
    newWikiOperationId,
} = require('./risubard-wiki-versioning.ts')
const { chatBoundaryAnchor, isWikiVcsTrackedPath } = require('../../src/ts/risubard/wikiVcsContract.ts')
const {
    completeMemoryWorkspaceFork,
    forkMemoryWorkspace,
    removeRebootMemoryWorkspace,
    replaceMemoryWorkspace,
    resolveMemoryReplacementStaging,
} = require('./risubard-memory-fork.ts')
const {
    createMemorySaveSlot,
    deleteMemorySaveSlot,
    listMemorySaveSlots,
    listAllMemorySaveSlots: listAllSaveSlots,
    memorySaveChatStateRoots,
    memorySaveWorkspaceId,
    prepareMemorySaveLoad,
    readMemorySaveChat,
    readMemorySaveSummary,
    readMemorySaveReference: readReferenceSave,
    readMemorySaveVcsSidecar: readSaveSidecar,
    renameMemorySaveReference: renameReferenceSave,
    renameMemorySaveSlot,
    writeMemorySaveReference: writeReferenceSave,
} = require('./risubard-memory-save.ts')
const {
    createWikiVcsRepository,
} = require('./risubard-wiki-vcs.ts')
const { revealLocalFile } = require('./reveal-local-file.cjs')
const { inheritWikiWorkspace, importWikiWorkspace } = require('./risubard-wiki-transfer.ts')

/**
 * Reads the canonical chat so a wiki write can be anchored to the real
 * message boundary instead of the wall-clock moment the request arrived.
 */
function loadCanonicalChatMessages(repository, characterId, chatId) {
    try {
        const chat = repository.loadChat(characterId, chatId)
        return Array.isArray(chat?.message) ? chat.message : undefined
    }
    catch (error) {
        if (error.code !== 'ENOENT') throw error
        return undefined
    }
}

function chatMessagesToAnchorMessages(messages) {
    return messages.flatMap((message) => {
        if (!message || typeof message !== 'object') return []
        if (typeof message.chatId !== 'string' || message.chatId.length === 0) {
            return []
        }
        return [{
            messageId: message.chatId,
            role: message.role === 'user' ? 'user' : 'assistant',
            data: typeof message.data === 'string' ? message.data : '',
            ...(message.disabled === undefined
                ? {} : { disabled: message.disabled }),
            ...(message.isComment === true ? { isComment: true } : {}),
        }]
    })
}

function createRuntimeMemoryService(userDataDirectory, options = {}) {
    let canonicalRepository
    const canonical = () => canonicalRepository ||= options.canonicalRepository
        || createUserDataRepository({ dataRoot: userDataDirectory })
    const runChatTransition = options.runChatTransition || (operation => operation())
    const pendingChatTransitions = new Map()
    const withChatTransition = (characterId, chatId, operation) => runChatTransition(async () => {
        const key = JSON.stringify([characterId, chatId])
        pendingChatTransitions.set(key, { characterId, chatId })
        const result = await operation()
        pendingChatTransitions.delete(key)
        return result
    })
    const applyChatState = async ({ characterId, chatId, previous, next }) => {
        const chat = chatUnpacker.unpack(Buffer.from(next, 'base64'))
        canonical().recoverPendingTransactions()
        canonical().replaceChat(
            characterId, chatId,
            chatUnpacker.unpack(Buffer.from(previous, 'base64')), chat
        )
        await options.onChatChanged?.({ characterId, chatId, chat })
    }
    const memory = createNarrativeMemoryService(userDataDirectory)
    const sources = createSourceSnapshotAdapter(userDataDirectory)
    const graph = createNarrativeGraphService(userDataDirectory, {
        loadV1State: (characterId, chatId) =>
            memory.loadState(characterId, chatId),
        applyV1Delta: (input) => memory.applyDelta(input),
    })
    const versioning = options.versioning || createWikiVersioning(
        userDataDirectory,
        {
            applyChatState,
            applyMemoryFork: async ({ characterId, chatId, forkToken }) => {
                await completeForkWorkspace({
                    userDataDirectory, characterId, destinationChatId: chatId,
                    forkToken, action: 'finalize',
                })
                await fs.rm(join(resolveMemoryWorkspace(
                    userDataDirectory, characterId, chatId
                ).directory, '.risubard-vcs-fork.json'), { force: true })
            },
            loadChatAnchor: options.loadChatAnchor
                || (async (characterId, chatId) => {
                    const messages = loadCanonicalChatMessages(canonical(), characterId, chatId)
                    if (!messages) return undefined
                    return chatBoundaryAnchor(
                        chatId,
                        messages.at(-1)?.chatId ?? null,
                        chatMessagesToAnchorMessages(messages)
                    )
                }),
            validateChatAnchor: options.validateChatAnchor || (options.loadChatAnchor
                ? undefined : (expected, _current, characterId) => {
                const persisted = loadCanonicalChatMessages(
                    canonical(), characterId, expected.sourceChatId
                )
                if (!persisted) return false
                const messages = chatMessagesToAnchorMessages(persisted)
                const boundaryIndex = expected.boundaryMessageId === null
                    ? -1
                    : messages.findIndex((message) =>
                        message.messageId === expected.boundaryMessageId)
                if (expected.boundaryMessageId !== null && boundaryIndex < 0) {
                    return false
                }
                const prefix = boundaryIndex < 0
                    ? []
                    : messages.slice(0, boundaryIndex + 1)
                return chatBoundaryAnchor(
                    expected.sourceChatId,
                    expected.boundaryMessageId,
                    prefix
                ).prefixDigest === expected.prefixDigest
            }),
        }
    )
    const wiki = createMarkdownNarrativeWiki(userDataDirectory, { versioning })
    const repository = createWikiVcsRepository(userDataDirectory)
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
    const pendingSaveLoads = new Map()
    const rememberWikiFork = async (input, fork, descriptor, staged) => {
        const characterId = input.destinationCharacterId || input.characterId
        const directory = staged
            ? resolveMemoryReplacementStaging(
                userDataDirectory, characterId, input.destinationChatId, fork.forkToken
            )
            : resolveMemoryWorkspace(
                userDataDirectory, characterId, input.destinationChatId
            ).directory
        await fs.mkdir(directory, { recursive: true })
        const file = await fs.open(join(directory, '.risubard-vcs-fork.json'), 'w', 0o600)
        try {
            await file.writeFile(JSON.stringify({
                schemaVersion: 1, characterId,
                chatId: input.destinationChatId, forkToken: fork.forkToken,
                descriptor,
            }))
            await file.sync()
        }
        finally { await file.close() }
        if (process.platform !== 'win32') {
            for (const parent of [directory, dirname(directory)]) {
                const handle = await fs.open(parent, 'r')
                try { await handle.sync() } finally { await handle.close() }
            }
        }
        pendingSaveLoads.set(fork.forkToken, descriptor)
    }
    const pendingWikiFork = async (input) => {
        if (pendingSaveLoads.has(input.forkToken)) {
            return pendingSaveLoads.get(input.forkToken)
        }
        const directories = [
            resolveMemoryReplacementStaging(
                userDataDirectory, input.characterId, input.destinationChatId, input.forkToken
            ),
            resolveMemoryWorkspace(
                userDataDirectory, input.characterId, input.destinationChatId
            ).directory,
        ]
        for (const directory of directories) {
            try {
                const path = join(directory, '.risubard-vcs-fork.json')
                const status = await fs.lstat(path)
                if (!status.isFile() || status.isSymbolicLink()) {
                    throw new Error('Wiki fork metadata is unsafe')
                }
                const record = JSON.parse(await fs.readFile(path, 'utf8'))
                if (record.schemaVersion !== 1
                    || record.characterId !== input.characterId
                    || record.chatId !== input.destinationChatId
                    || record.forkToken !== input.forkToken
                    || !/^[a-f0-9]{64}$/u.test(record.descriptor?.commitId)
                    || typeof record.descriptor?.sourceChatId !== 'string') {
                    throw new Error('Wiki fork metadata does not match')
                }
                return record.descriptor
            }
            catch (error) {
                if (error.code === 'ENOENT') continue
                throw error
            }
        }
        return undefined
    }

    const queues = new Map()
    const wikiRecoveryReady = new Set()
    let snapshotBarrier
    const serializedMany = (pairs, operation) => {
        // Wiki objects, refs, save manifests, and chat workspaces are shared
        // per character. Every client therefore contends on the same
        // character lock in addition to its chat lock.
        const expanded = [
            ...pairs,
            ...pairs.map(([characterId]) => [
                characterId, '@character-repository',
            ]),
        ]
        const keys = [...new Set(expanded.map((pair) => JSON.stringify(pair)))]
            .sort()
        const previous = keys.map((key) => queues.get(key) || Promise.resolve())
        if (snapshotBarrier) previous.push(snapshotBarrier)
        const current = Promise.all(previous.map((pending) =>
            pending.catch(() => undefined)
        )).then(operation)
        for (const key of keys) queues.set(key, current)
        current.catch(() => {
            for (const pair of pairs) wikiRecoveryReady.delete(JSON.stringify(pair))
        })
        current.finally(() => {
            for (const key of keys) {
                if (queues.get(key) === current) queues.delete(key)
            }
        }).catch(() => undefined)
        return current
    }
    const serialized = (characterId, chatId, operation) => serializedMany(
        [[characterId, chatId]],
        operation
    )
    const recoverLegacyWikiSwap = async (characterId, chatId) => {
        const directory = resolveMemoryWorkspace(
            userDataDirectory, characterId, chatId
        ).directory
        const live = join(directory, 'wiki')
        try {
            await fs.lstat(live)
            return
        }
        catch (error) {
            if (error.code !== 'ENOENT') throw error
        }
        let entries
        try { entries = await fs.readdir(directory) }
        catch (error) {
            if (error.code === 'ENOENT') return
            throw error
        }
        const backups = entries.filter((name) =>
            /^wiki\.write-backup-[a-f0-9-]{36}$/u.test(name))
        if (backups.length === 0) return
        if (backups.length !== 1) {
            throw new Error('Wiki operation pending: multiple legacy working-tree backups require recovery')
        }
        const realRoot = await fs.realpath(userDataDirectory)
        if (await fs.realpath(directory) !== join(realRoot, relative(userDataDirectory, directory))) {
            throw new Error('Wiki operation pending: legacy backup directory is unsafe')
        }
        const backup = join(directory, backups[0])
        const status = await fs.lstat(backup)
        if (!status.isDirectory() || status.isSymbolicLink()) {
            throw new Error('Wiki operation pending: legacy working-tree backup is unsafe')
        }
        await fs.rename(backup, live)
        if (process.platform !== 'win32') {
            const handle = await fs.open(directory, 'r')
            try { await handle.sync() }
            finally { await handle.close() }
        }
        wiki.invalidateCache(characterId, chatId)
    }
    const ensureWikiRecovered = async (characterId, chatId) => {
        const key = JSON.stringify([characterId, chatId])
        if (wikiRecoveryReady.has(key)) return
        await recoverLegacyWikiSwap(characterId, chatId)
        const recovered = await versioning.recoverOperations({ characterId, chatId })
        if (recovered.conflicts?.length > 0) {
            throw new Error(recovered.conflicts.join('\n'))
        }
        if (recovered.unresolved.length > 0) {
            throw new Error('Wiki operation pending: recovery must complete before access')
        }
        if (recovered.completed.length > 0) {
            await wiki.rebuildDerivedFiles(characterId, chatId)
        }
        wikiRecoveryReady.add(key)
    }
    const withWikiBaseline = async (input, operation) => {
        wiki.assertWriteOwnership(input)
        await ensureWikiRecovered(input.characterId, input.chatId)
        await versioning.ensureBaseline({
            characterId: input.characterId,
            chatId: input.chatId,
            ...(input.chatAnchor ? { chatAnchor: input.chatAnchor } : {}),
            operationId: newWikiOperationId('baseline'),
        })
        return operation()
    }

    const decodeChatSnapshot = (chatBase64, chatId) => {
        if (typeof chatBase64 !== 'string') throw new Error('Wiki checkout requires a chat snapshot')
        const chat = chatUnpacker.unpack(Buffer.from(chatBase64, 'base64'))
        if (!chat || chat.id !== chatId || !Array.isArray(chat.message)) {
            throw new Error('Invalid wiki checkout chat snapshot')
        }
        return chat
    }
    const checkoutChat = async (input, preparedChat) => {
        await ensureWikiRecovered(input.characterId, input.chatId)
        await options.beforeChatTransition?.()
        const chat = preparedChat ?? decodeChatSnapshot(input.chatBase64, input.chatId)
        const chatStateRef = await repository.storeChatState({
            characterId: input.characterId, chatId: input.chatId,
            contents: input.chatBase64,
        })
        const completed = input.operationId
            ? await repository.readOperationReceipt(input) : undefined
        let previous
        try { previous = canonical().loadChat(input.characterId, input.chatId) }
        catch (error) {
            if (!['fork', 'save-load', 'purge-restore'].includes(input.reason)
                || error.code !== 'ENOENT') throw error
            previous = null
        }
        if (!completed && input.expectedChatAnchor) {
            const messages = chatMessagesToAnchorMessages(previous?.message ?? [])
            const current = chatBoundaryAnchor(input.chatId, messages.at(-1)?.messageId ?? null, messages)
            const expected = input.expectedChatAnchor
            if (expected.sourceChatId !== current.sourceChatId
                || expected.boundaryMessageId !== current.boundaryMessageId
                || expected.prefixDigest !== current.prefixDigest) {
                throw new Error('Wiki chat conflict: the persisted chat changed before checkout')
            }
        }
        const previousChatStateRef = await repository.storeChatState({
            characterId: input.characterId, chatId: input.chatId,
            contents: chatPacker.pack(previous).toString('base64'),
        })
        const result = await versioning.checkout({
            ...input, previousChatStateRef, chatStateRef,
        })
        await wiki.rebuildDerivedFiles(input.characterId, input.chatId)
        return result
    }

    const atWikiIdle = async (operation) => {
        const pending = [...new Set(queues.values())]
        const previousBarrier = snapshotBarrier
        let release
        const barrier = new Promise(resolve => { release = resolve })
        snapshotBarrier = barrier
        try {
            await previousBarrier
            await Promise.all(pending.map(operation => operation.catch(() => undefined)))
            return await operation()
        }
        finally {
            release()
            if (snapshotBarrier === barrier) snapshotBarrier = undefined
        }
    }
    const recoverAllWikiOperations = async () => {
        const charactersDirectory = join(userDataDirectory, 'risubard', 'characters')
        const list = async directory => {
            try { return await fs.readdir(directory, { withFileTypes: true }) }
            catch (error) { if (error.code === 'ENOENT') return []; throw error }
        }
        const owners = new Map()
        for (const character of await list(charactersDirectory)) {
            if (!character.isDirectory() || character.isSymbolicLink()) continue
            const operationsDirectory = join(
                charactersDirectory, character.name, 'chats', 'wiki-vcs', 'operations'
            )
            for (const operation of await list(operationsDirectory)) {
                if (!operation.isDirectory() || operation.isSymbolicLink()) continue
                let journal
                try {
                    journal = JSON.parse(await fs.readFile(
                        join(operationsDirectory, operation.name, 'journal.json'), 'utf8'
                    ))
                }
                catch (error) { if (error.code === 'ENOENT') continue; throw error }
                if (!journal.published && typeof journal.characterId === 'string'
                    && typeof journal.chatId === 'string') {
                    owners.set(JSON.stringify([journal.characterId, journal.chatId]), journal)
                }
            }
        }
        for (const [key, { characterId, chatId }] of owners) {
            wikiRecoveryReady.delete(key)
            await ensureWikiRecovered(characterId, chatId)
            pendingChatTransitions.delete(key)
        }
    }
    const wikiPollMonitors = new Map()
    const pollMonitorFor = (characterId, chatId) => {
        const key = JSON.stringify([characterId, chatId])
        let monitor = wikiPollMonitors.get(key)
        if (monitor) return monitor
        monitor = { epoch: 0, observedEpoch: -1, lastScan: 0, watcher: null }
        if (process.platform !== 'android' && !String(process.env.PREFIX || '').includes('com.termux')) {
            try {
                const directory = join(resolveMemoryWorkspace(userDataDirectory, characterId, chatId).directory, 'wiki')
                monitor.watcher = watch(realpathSync.native(directory), { recursive: true }, (event, filename) => {
                    const name = String(filename || '').replaceAll('\\', '/')
                    if (!name || isWikiVcsTrackedPath(name)
                        || (event === 'rename' && name !== 'index.md' && !name.endsWith('.tmp'))) monitor.epoch++
                })
                monitor.watcher.on('error', error => {
                    monitor.watcher.close()
                    monitor.watcher = null
                    monitor.epoch++
                    console.warn('[Wiki] History monitor failed; using full scans:', error.message)
                })
                monitor.watcher.unref()
            } catch (error) {
                if (error.code !== 'ENOENT') console.warn('[Wiki] History monitor unavailable; using full scans:', error.message)
            }
        }
        wikiPollMonitors.set(key, monitor)
        if (wikiPollMonitors.size > 16) {
            const oldest = wikiPollMonitors.keys().next().value
            wikiPollMonitors.get(oldest).watcher?.close()
            wikiPollMonitors.delete(oldest)
        }
        return monitor
    }
    return {
        ...memory,
        recoverPendingChatTransitionsWithinQueue: async () => {
            for (const [key, owner] of pendingChatTransitions) {
                await serialized(owner.characterId, owner.chatId, () =>
                    ensureWikiRecovered(owner.characterId, owner.chatId))
                pendingChatTransitions.delete(key)
            }
        },
        wikiOperationResult: (input) => runChatTransition(() => serialized(
            input.characterId, input.chatId, async () => {
                await ensureWikiRecovered(input.characterId, input.chatId)
                return { receipt: await repository.readOperationReceipt(input) ?? null }
            }
        )),
        recoverWikiOperations: () => runChatTransition(() => atWikiIdle(recoverAllWikiOperations)),
        withConsistentSnapshot: operation => atWikiIdle(async () => {
            await recoverAllWikiOperations()
            return operation()
        }),
        inheritWiki: (input) => serializedMany([
            [input.characterId, input.sourceChatId],
            [input.characterId, input.destinationChatId],
        ], async () => {
            await versioning.ensureBaseline({
                characterId: input.characterId,
                chatId: input.sourceChatId,
                operationId: newWikiOperationId('baseline'),
            })
            const inherited = await inheritWikiWorkspace({
                userDataDirectory, ...input,
            })
            await versioning.afterWrite({
                characterId: input.characterId,
                chatId: input.destinationChatId,
                kind: 'import',
                operationId: newWikiOperationId('import'),
            })
            wiki.invalidateCache(input.characterId, input.destinationChatId)
            return inherited
        }),
        importWiki: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => {
                await versioning.ensureBaseline({
                    characterId: input.characterId,
                    chatId: input.chatId,
                    operationId: newWikiOperationId('baseline'),
                })
                const imported = await importWikiWorkspace({
                    userDataDirectory, ...input,
                })
                await versioning.afterWrite({
                    characterId: input.characterId,
                    chatId: input.chatId,
                    kind: 'import',
                    operationId: newWikiOperationId('import'),
                })
                wiki.invalidateCache(input.characterId, input.chatId)
                return imported
            }
        ),
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
            await versioning.ensureBaseline({
                characterId: input.characterId, chatId: input.sourceChatId,
            })
            await versioning.captureExternalChanges({
                characterId: input.characterId,
                chatId: input.sourceChatId,
            })
            const commitId = await versioning.readHead(
                input.characterId, input.sourceChatId
            )
            const fork = await forkWorkspace({
                userDataDirectory,
                ...input,
            })
            if (commitId) {
                await rememberWikiFork(input, fork, {
                    commitId,
                    sourceChatId: input.sourceChatId,
                    sourceCharacterId: input.characterId,
                    destinationCharacterId:
                        input.destinationCharacterId || input.characterId,
                    replace: false,
                }, false)
            }
            return fork
        }),
        replaceMemory: (input) => serializedMany([
            [input.characterId, input.sourceChatId],
            [input.characterId, input.destinationChatId],
        ], async () => {
            await versioning.ensureBaseline({
                characterId: input.characterId, chatId: input.sourceChatId,
            })
            await versioning.captureExternalChanges({
                characterId: input.characterId,
                chatId: input.sourceChatId,
            })
            const commitId = await versioning.readHead(
                input.characterId, input.sourceChatId
            )
            const fork = await replaceWorkspace({ userDataDirectory, ...input })
            if (commitId) {
                await rememberWikiFork(input, fork, {
                    commitId,
                    sourceChatId: input.sourceChatId,
                    sourceCharacterId: input.characterId,
                    destinationCharacterId: input.characterId,
                    replace: true,
                }, true)
            }
            return fork
        }),
        removeRebootMemory: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => {
                if (!input.chatId.startsWith('reboot-')) {
                    throw new Error('Only reboot staging workspaces can be removed')
                }
                await repository.discardChatBranch(
                    input.characterId, input.chatId
                )
                const removed = await removeRebootWorkspace({
                    userDataDirectory,
                    ...input,
                })
                wiki.invalidateCache(input.characterId, input.chatId)
                return removed
            }
        ),
        completeMemoryFork: (input) => (input.chatBase64
            ? operation => withChatTransition(input.characterId, input.destinationChatId, operation)
            : operation => operation())(() => serialized(
            input.characterId,
            input.destinationChatId,
            async () => {
                const pending = await pendingWikiFork(input)
                if (input.action === 'finalize' && (pending?.mode === 'save-load' || input.chatBase64)) {
                    const operationId = `save-load:${input.forkToken}`
                    if (!pending?.commitId) {
                        const receipt = await repository.readOperationReceipt({
                            characterId: input.characterId, chatId: input.destinationChatId, operationId,
                        })
                        if (!receipt) throw new Error('Memory save load metadata is missing')
                        return { action: 'finalize', completed: true }
                    }
                    await checkoutChat({
                        characterId: input.characterId, chatId: input.destinationChatId,
                        commitId: pending.commitId, operationId, reason: 'save-load',
                        chatBase64: input.chatBase64, memoryForkToken: input.forkToken,
                    })
                    pendingSaveLoads.delete(input.forkToken)
                    return { action: 'finalize', completed: true }
                }
                const completed = await completeForkWorkspace({
                    userDataDirectory,
                    ...input,
                })
                if (input.action === 'discard') {
                    pendingSaveLoads.delete(input.forkToken)
                }
                else if (pending?.commitId) {
                    const sourceCharacterId = pending.sourceCharacterId
                        || input.characterId
                    const destinationCharacterId = pending.destinationCharacterId
                        || input.characterId
                    if (sourceCharacterId !== destinationCharacterId) {
                        await versioning.ensureBaseline({
                            characterId: destinationCharacterId,
                            chatId: input.destinationChatId,
                            operationId: `fork-baseline:${input.forkToken}`,
                        })
                    }
                    else if (pending.replace
                        || pending.sourceChatId === input.destinationChatId) {
                        await versioning.checkout({
                            characterId: destinationCharacterId,
                            chatId: input.destinationChatId,
                            commitId: pending.commitId,
                            reason: 'save-load',
                        })
                    }
                    else {
                        await versioning.fork({
                            characterId: destinationCharacterId,
                            sourceChatId: pending.sourceChatId,
                            destinationChatId: input.destinationChatId,
                            commitId: pending.commitId,
                        })
                    }
                    pendingSaveLoads.delete(input.forkToken)
                }
                if (input.action === 'finalize') {
                    await wiki.rebuildDerivedFiles(
                        input.characterId,
                        input.destinationChatId
                    )
                    await fs.rm(join(resolveMemoryWorkspace(
                        userDataDirectory, input.characterId, input.destinationChatId
                    ).directory, '.risubard-vcs-fork.json'), { force: true })
                }
                return completed
            }
        )),
        createMemorySave: (input) => serializedMany([
            [input.characterId, input.sourceChatId],
            [input.characterId, memorySaveWorkspaceId(input.saveId)],
        ], async () => {
            await versioning.ensureBaseline({
                characterId: input.characterId, chatId: input.sourceChatId,
            })
            const previousReference = input.overwrite
                ? await readReferenceSave({
                    userDataDirectory,
                    characterId: input.characterId,
                    saveId: input.saveId,
                })
                : null
            // Uncommitted external edits are recorded first so the save points
            // at a commit that matches what is actually on disk.
            const capture = await versioning.captureExternalChanges({
                characterId: input.characterId,
                chatId: input.sourceChatId,
            })
            const head = await versioning.readHead(
                input.characterId, input.sourceChatId
            )
            const view = await wiki.loadView(
                input.characterId,
                input.sourceChatId
            )
            const latest = view.documents
                .filter((document) => document.type === 'event'
                    && document.status === 'active')
                .sort((left, right) =>
                    (right.created || '').localeCompare(left.created || '')
                    || right.id.localeCompare(left.id)
                )[0]
            const excerpt = latest?.content
                .replace(/^#\s+[^\r\n]+\r?\n*/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 500)
            const saved = await createSaveSlot({
                userDataDirectory,
                ...input,
                ...(latest ? {
                    latestEvent: {
                        title: latest.title,
                        excerpt: excerpt || latest.title,
                    },
                } : {}),
                ...(head ? {
                    vcs: {
                        commitId: head,
                        head,
                    },
                } : {}),
            })
            const refId = head
                ? await versioning.createRef({
                    characterId: input.characterId,
                    chatId: input.sourceChatId,
                    commitId: head,
                    kind: 'save',
                    id: `save-slot:${input.saveId}`,
                    label: input.saveId,
                })
                : null
            if (previousReference) {
                await versioning.deleteRef({
                    characterId: input.characterId,
                    chatId: previousReference.sourceChatId,
                    kind: 'autosave',
                    id: `autosave:${input.saveId}`,
                })
                await repository.collectChatState({
                    characterId: input.characterId,
                    chatId: previousReference.sourceChatId,
                    referencedHashes: await memorySaveChatStateRoots({
                        userDataDirectory, characterId: input.characterId,
                    }),
                })
            }
            return {
                ...saved,
                ...(head ? { wikiCommitId: head } : {}),
                ...(refId ? { wikiRefId: refId } : {}),
                ...(capture.commitId
                    ? { capturedCommitId: capture.commitId } : {}),
            }
        }),
        listMemorySaves: (input) => listSaveSlots({
            userDataDirectory,
            ...input,
        }),
        listAllMemorySaves: (input) => serialized(
            input.characterId,
            input.sourceChatId,
            () => listAllSaveSlots({ userDataDirectory, ...input })
        ),
        /**
         * Preview for either format: the v1 snapshot reads its stored chat, and
         * a reference save reads its deduplicated chat-state object.
         */
        previewMemorySave: (input) => serialized(
            input.characterId,
            memorySaveWorkspaceId(input.saveId),
            async () => {
                const reference = await readReferenceSave({
                    userDataDirectory,
                    characterId: input.characterId,
                    saveId: input.saveId,
                }).catch(() => null)
                if (!reference) {
                    return previewSaveSlot({ userDataDirectory, ...input })
                }
                const stored = await repository.readChatState({
                    characterId: input.characterId,
                    chatId: reference.sourceChatId,
                    hash: reference.chatStateRef,
                })
                if (stored === null) {
                    throw new Error(
                        'Memory reference save chat state is missing'
                    )
                }
                return Buffer.from(stored, 'base64')
            }
        ),
        renameMemorySave: (input) => serialized(
            input.characterId,
            memorySaveWorkspaceId(input.saveId),
            async () => {
                const reference = await readReferenceSave({
                    userDataDirectory,
                    characterId: input.characterId,
                    saveId: input.saveId,
                }).catch(() => null)
                if (!reference) {
                    return renameSaveSlot({ userDataDirectory, ...input })
                }
                // Reference saves keep their label in the reference manifest.
                const renamed = await renameReferenceSave({
                    userDataDirectory,
                    characterId: input.characterId,
                    saveId: input.saveId,
                    name: input.name,
                })
                return {
                    saveId: renamed.saveId,
                    sourceChatId: renamed.sourceChatId,
                    sourceChatName: renamed.sourceChatName,
                    createdAt: renamed.createdAt,
                    turnCount: renamed.turnCount,
                    ...(renamed.latestMessageId
                        ? { latestMessageId: renamed.latestMessageId } : {}),
                    ...(renamed.latestEvent
                        ? { latestEvent: renamed.latestEvent } : {}),
                }
            }
        ),
        deleteMemorySave: (input) => serialized(
            input.characterId,
            memorySaveWorkspaceId(input.saveId),
            async () => {
                const reference = await readReferenceSave({
                    userDataDirectory,
                    characterId: input.characterId,
                    saveId: input.saveId,
                })
                const sidecar = await readSaveSidecar({
                    userDataDirectory, characterId: input.characterId, saveId: input.saveId,
                })
                let legacySave
                try {
                    legacySave = await readMemorySaveSummary({
                        userDataDirectory,
                        characterId: input.characterId,
                        saveId: input.saveId,
                    })
                }
                catch (error) {
                    if (error.code !== 'ENOENT') throw error
                }
                const chatId = reference?.sourceChatId
                    ?? sidecar?.sourceChatId
                    ?? legacySave?.sourceChatId
                    ?? input.sourceChatId
                const deleted = await deleteSaveSlot({ userDataDirectory, ...input })
                if (chatId) {
                    await versioning.deleteRef({
                        characterId: input.characterId,
                        chatId,
                        kind: reference ? 'autosave' : 'save',
                        id: reference
                            ? `autosave:${input.saveId}`
                            : `save-slot:${input.saveId}`,
                    })
                    await repository.collectChatState({
                        characterId: input.characterId, chatId,
                        referencedHashes: await memorySaveChatStateRoots({
                            userDataDirectory, characterId: input.characterId,
                        }),
                    })
                    await repository.collectGarbage({
                        characterId: input.characterId, chatId,
                    })
                }
                return deleted
            }
        ),
        prepareMemorySaveLoad: (input) => serializedMany([
            [input.characterId, memorySaveWorkspaceId(input.saveId)],
            [input.characterId, input.destinationChatId],
        ], async () => {
            const sidecar = await readSaveSidecar({
                userDataDirectory, characterId: input.characterId, saveId: input.saveId,
            })
            const prepared = await prepareSaveLoad({ userDataDirectory, ...input })
            try {
                let commitId = sidecar?.commitId
                if (commitId && !await repository.matchesWorkingTree({
                    characterId: input.characterId, chatId: memorySaveWorkspaceId(input.saveId), commitId,
                })) commitId = undefined
                if (!commitId) {
                    const chat = chatUnpacker.unpack(prepared.chatBytes)
                    if (!chat || !Array.isArray(chat.message)) throw new Error('Invalid memory save chat snapshot')
                    const importChatId = `reboot-save-${prepared.fork.forkToken}`
                    const imported = resolveMemoryWorkspace(userDataDirectory, input.characterId, importChatId)
                    const staging = resolveMemoryReplacementStaging(
                        userDataDirectory, input.characterId, input.destinationChatId, prepared.fork.forkToken
                    )
                    try {
                        await fs.mkdir(imported.directory, { recursive: true })
                        let wikiExists = false
                        try { await fs.lstat(join(staging, 'wiki')); wikiExists = true }
                        catch (error) { if (error.code !== 'ENOENT') throw error }
                        if (wikiExists) await fs.cp(join(staging, 'wiki'), join(imported.directory, 'wiki'), {
                            recursive: true, mode: fs.constants.COPYFILE_FICLONE,
                        })
                        const messages = chatMessagesToAnchorMessages(chat.message)
                        const baseline = await repository.ensureBaseline({
                            characterId: input.characterId, chatId: importChatId,
                            chatAnchor: chatBoundaryAnchor(prepared.save.sourceChatId, messages.at(-1)?.messageId ?? null, messages),
                        })
                        commitId = baseline.commitId
                        await versioning.createRef({
                            characterId: input.characterId, chatId: prepared.save.sourceChatId,
                            commitId, kind: 'save', id: `save-slot:${input.saveId}`, label: input.saveId,
                        })
                        for (const message of chat.message) {
                            if (message.risubardCanonicalReceipt) {
                                delete message.risubardCanonicalReceipt
                                message.risubardMemoryConfirmed = false
                            }
                        }
                        prepared.chatBytes = chatPacker.pack(chat)
                    } finally {
                        await repository.discardChatBranch(input.characterId, importChatId)
                        await fs.rm(imported.directory, { recursive: true, force: true })
                    }
                }
                await rememberWikiFork(input, prepared.fork, {
                    mode: 'save-load', commitId, sourceChatId: prepared.save.sourceChatId,
                }, true)
                return { ...prepared, wikiCommitId: commitId }
            } catch (error) {
                await completeForkWorkspace({
                    userDataDirectory, characterId: input.characterId,
                    destinationChatId: input.destinationChatId,
                    forkToken: prepared.fork.forkToken, action: 'discard',
                })
                throw error
            }
        }),
        readMemorySaveSidecar: (input) => serialized(
            input.characterId,
            memorySaveWorkspaceId(input.saveId),
            () => readSaveSidecar({
                userDataDirectory,
                characterId: input.characterId,
                saveId: input.saveId,
            })
        ),
        /**
         * Reference autosave: records the chat and the wiki commit it sits at
         * without copying the wiki tree. Chat bytes are deduplicated by hash, so
         * an unchanged chat adds no storage.
         */
        writeReferenceAutosave: (input) => serializedMany([
            [input.characterId, input.sourceChatId],
            [input.characterId, memorySaveWorkspaceId(input.saveId)],
        ], async () => {
            await versioning.ensureBaseline({
                characterId: input.characterId, chatId: input.sourceChatId,
            })
            const capture = await versioning.captureExternalChanges({
                characterId: input.characterId,
                chatId: input.sourceChatId,
            })
            const head = await versioning.readHead(
                input.characterId, input.sourceChatId
            )
            const chatBytes = Buffer.isBuffer(input.chatBytes)
                ? input.chatBytes
                : Buffer.from(input.chatBytes)
            const chatHash = await repository.storeChatState({
                characterId: input.characterId,
                chatId: input.sourceChatId,
                contents: chatBytes.toString('base64'),
            })
            const record = await writeReferenceSave({
                userDataDirectory,
                characterId: input.characterId,
                sourceChatId: input.sourceChatId,
                saveId: input.saveId,
                sourceChatName: input.sourceChatName,
                turnCount: input.turnCount,
                chatStateRef: chatHash,
                ...(head ? { wikiCommitId: head } : {}),
                ...(input.latestMessageId
                    ? { latestMessageId: input.latestMessageId } : {}),
                ...(input.latestEvent ? { latestEvent: input.latestEvent } : {}),
            })
            const wikiRefId = head
                ? await versioning.createRef({
                    characterId: input.characterId,
                    chatId: input.sourceChatId,
                    commitId: head,
                    kind: 'autosave',
                    chatStateRef: chatHash,
                    id: `autosave:${input.saveId}`,
                    label: input.saveId,
                })
                : null
            return {
                ...record,
                chatHash,
                ...(wikiRefId ? { wikiRefId } : {}),
                ...(capture.commitId
                    ? { capturedCommitId: capture.commitId } : {}),
            }
        }),
        /**
         * Loads a reference save: the wiki is materialized in the destination
         * chat from the pinned commit, and the chat bytes come from the
         * deduplicated chat-state object.
         */
        prepareReferenceSaveLoad: (input) => serializedMany([
            [input.characterId, memorySaveWorkspaceId(input.saveId)],
            [input.characterId, input.destinationChatId],
        ], async () => {
            const record = await readReferenceSave({
                userDataDirectory,
                characterId: input.characterId,
                saveId: input.saveId,
            })
            if (!record) {
                return { reference: null }
            }
            const stored = await repository.readChatState({
                characterId: input.characterId,
                chatId: record.sourceChatId,
                hash: record.chatStateRef,
            })
            if (stored === null) {
                throw new Error(
                    'Memory reference save chat state is missing'
                )
            }
            if (record.wikiCommitId) {
                const exists = await repository.readCommit(
                    input.characterId,
                    record.sourceChatId,
                    record.wikiCommitId
                )
                if (!exists) {
                    throw new Error(
                        'Memory reference save wiki commit is missing'
                    )
                }
            }
            return {
                reference: record,
                chatBytes: Buffer.from(stored, 'base64'),
            }
        }),
        collectReferenceGarbage: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => {
                const referencedHashes = await memorySaveChatStateRoots({
                    userDataDirectory, characterId: input.characterId,
                })
                return repository.collectChatState({
                    characterId: input.characterId,
                    chatId: input.chatId,
                    referencedHashes,
                })
            }
        ),
        /**
         * Writes a v1-compatible save from a reference save so older builds can
         * read it. The wiki working tree is materialized at the pinned commit
         * first, because a v1 save carries the files rather than a reference.
         */
        exportReferenceSaveCompat: (input) => serializedMany([
            [input.characterId, memorySaveWorkspaceId(input.saveId)],
            [input.characterId, memorySaveWorkspaceId(input.targetSaveId)],
        ], async () => {
            const record = await readReferenceSave({
                userDataDirectory,
                characterId: input.characterId,
                saveId: input.saveId,
            })
            if (!record) {
                throw new Error('Memory reference save does not exist')
            }
            const stored = await repository.readChatState({
                characterId: input.characterId,
                chatId: record.sourceChatId,
                hash: record.chatStateRef,
            })
            if (stored === null) {
                throw new Error('Memory reference save chat state is missing')
            }
            const compatibilityWorkspaceId = `reboot-compat-${randomUUID()}`
            if (record.wikiCommitId) {
                const exists = await repository.readCommit(
                    input.characterId,
                    record.sourceChatId,
                    record.wikiCommitId
                )
                if (!exists) {
                    throw new Error('Memory reference save wiki commit is missing')
                }
                await repository.fork({
                    characterId: input.characterId,
                    sourceChatId: record.sourceChatId,
                    destinationChatId: compatibilityWorkspaceId,
                    commitId: record.wikiCommitId,
                })
            }
            else {
                await fs.mkdir(resolveMemoryWorkspace(
                    userDataDirectory, input.characterId, compatibilityWorkspaceId
                ).directory, { recursive: true })
            }
            const overwrite = (await listAllSaveSlots({
                userDataDirectory,
                characterId: input.characterId,
                sourceChatId: record.sourceChatId,
            })).some((slot) => slot.saveId === input.targetSaveId)
            const previousTargetReference = overwrite
                ? await readReferenceSave({
                    userDataDirectory,
                    characterId: input.characterId,
                    saveId: input.targetSaveId,
                })
                : null
            try {
                const saved = await createSaveSlot({
                    userDataDirectory,
                    characterId: input.characterId,
                    sourceChatId: record.sourceChatId,
                    workspaceSourceChatId: compatibilityWorkspaceId,
                    saveId: input.targetSaveId,
                    overwrite,
                    sourceChatName: input.sourceChatName ?? record.sourceChatName,
                    turnCount: record.turnCount,
                    chatBytes: Buffer.from(stored, 'base64'),
                    ...(record.latestMessageId
                        ? { latestMessageId: record.latestMessageId } : {}),
                    ...(record.latestEvent
                        ? { latestEvent: record.latestEvent } : {}),
                    ...(record.wikiCommitId
                        ? { vcs: { commitId: record.wikiCommitId } } : {}),
                })
                if (record.wikiCommitId) await versioning.createRef({
                    characterId: input.characterId,
                    chatId: record.sourceChatId,
                    commitId: record.wikiCommitId,
                    kind: 'save',
                    id: `save-slot:${input.targetSaveId}`,
                    label: input.targetSaveId,
                })
                if (previousTargetReference) {
                    await versioning.deleteRef({
                        characterId: input.characterId,
                        chatId: previousTargetReference.sourceChatId,
                        kind: 'autosave',
                        id: `autosave:${input.targetSaveId}`,
                    })
                    await repository.collectChatState({
                        characterId: input.characterId,
                        chatId: previousTargetReference.sourceChatId,
                        referencedHashes: await memorySaveChatStateRoots({
                            userDataDirectory, characterId: input.characterId,
                        }),
                    })
                }
                return saved
            }
            finally {
                await repository.discardChatBranch(
                    input.characterId, compatibilityWorkspaceId
                )
                await removeRebootWorkspace({
                    userDataDirectory,
                    characterId: input.characterId,
                    chatId: compatibilityWorkspaceId,
                })
            }
        }),
        loadGraphState: (characterId, chatId) =>
            graph.loadState(characterId, chatId),
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
        readGraphForInquiry: (characterId, chatId) =>
            graph.readForInquiry(characterId, chatId),
        inquireNarrative: (input) => serialized(
            input.characterId, input.chatId, async () => {
                await ensureWikiRecovered(input.characterId, input.chatId)
                return wiki.inquire(input)
            }
        ),
        embeddingCatalog: (input) => serialized(
            input.characterId, input.chatId, async () => {
                await ensureWikiRecovered(input.characterId, input.chatId)
                return wiki.embeddingCatalog(input)
            }
        ),
        saveMarkdownWikiTurn: (input) => serialized(
            input.characterId,
            input.chatId,
            () => withWikiBaseline(input, () => wiki.saveConfirmedTurn(input))
        ),
        beginWikiWriteBatch: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => {
                await ensureWikiRecovered(input.characterId, input.chatId)
                return wiki.beginWriteBatch(input)
            }
        ),
        publishWikiWriteBatch: (input, signal) => runChatTransition(() => serialized(
            input.characterId, input.chatId, async () => {
                await options.beforeChatTransition?.()
                return wiki.publishWriteBatch(input, signal)
            }
        )),
        abandonWikiWriteBatch: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.abandonWriteBatch(input)
        ),
        saveCanonicalWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            () => withWikiBaseline(input, () => wiki.saveCanonicalDocument(input))
        ),
        reviewCanonicalWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            () => withWikiBaseline(input, () => wiki.reviewCanonicalDocument(input))
        ),
        beginBardChatUndo: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.beginBardChatUndo(input)
        ),
        finalizeBardChatUndo: (input) => serialized(
            input.characterId,
            input.chatId,
            () => withWikiBaseline(input, () => wiki.finalizeBardChatUndo(input))
        ),
        getBardChatUndoStatus: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.getBardChatUndoStatus(input)
        ),
        restoreBardChatUndo: (input) => serialized(
            input.characterId,
            input.chatId,
            () => withWikiBaseline(input, () => wiki.restoreBardChatUndo(input))
        ),
        saveManualWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            () => withWikiBaseline(input, () => wiki.saveManualDocument(input))
        ),
        replaceWikiText: (input) => serialized(
            input.characterId,
            input.chatId,
            () => withWikiBaseline(input, () => wiki.replaceAllText(input))
        ),
        setWikiDocumentContextMode: (input) => serialized(
            input.characterId,
            input.chatId,
            () => withWikiBaseline(input, () => wiki.setDocumentContextMode(input))
        ),
        trashWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            () => withWikiBaseline(input, () => wiki.trashDocument(input))
        ),
        retractWikiEvent: (input) => serialized(
            input.characterId,
            input.chatId,
            () => withWikiBaseline(input, () => wiki.retractEvent(input))
        ),
        retractWikiEventsBySourceMessages: (input) => serialized(
            input.characterId,
            input.chatId,
            () => withWikiBaseline(
                input, () => wiki.retractEventsBySourceMessages(input)
            )
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
            () => wiki.completeRebootBatch(input)
        ),
        recordGraphAnalysis: (characterId, chatId, result) => serialized(
            characterId,
            chatId,
            () => graph.recordAnalysis(characterId, chatId, result)
        ),
        async applyWriterCommand(input) {
            return serialized(input.characterId, input.chatId, async () => {
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
        async loadView(characterId, chatId) {
            return serialized(characterId, chatId, async () => {
                await ensureWikiRecovered(characterId, chatId)
                return wiki.loadView(characterId, chatId)
            })
        },
        // ── Wiki version store ───────────────────────────────────────────
        ensureWikiVersion: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => {
                // Any operation interrupted by a crash is finished before new
                // work starts, so history cannot be built on a half-published
                // commit.
                await ensureWikiRecovered(input.characterId, input.chatId)
                return versioning.ensureBaseline({
                    ...input,
                    operationId: input.operationId
                        || newWikiOperationId('baseline'),
                })
            }
        ),
        captureWikiExternalChanges: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => {
                await ensureWikiRecovered(input.characterId, input.chatId)
                const monitor = input.poll ? pollMonitorFor(input.characterId, input.chatId) : null
                if (monitor?.watcher && monitor.observedEpoch === monitor.epoch
                    && Date.now() - monitor.lastScan < 60_000) {
                    return { commitId: null, changedPaths: [] }
                }
                const epoch = monitor?.epoch
                const result = await versioning.captureExternalChanges(input)
                if (result.commitId) {
                    await wiki.rebuildDerivedFiles(
                        input.characterId, input.chatId
                    )
                }
                if (monitor) {
                    monitor.observedEpoch = epoch
                    monitor.lastScan = Date.now()
                }
                return result
            }
        ),
        previewWikiCheckout: (input) => serialized(
            input.characterId,
            input.chatId,
            () => versioning.previewCheckout(input)
        ),
        wikiAncestors: (input) => serialized(
            input.characterId, input.chatId,
            () => versioning.readCommitAncestors(input)
        ),
        wikiHistory: (input) => serialized(
            input.characterId,
            input.chatId,
            () => versioning.listHistory(input)
        ),
        wikiCheckout: (input) => withChatTransition(input.characterId, input.chatId, () => serialized(
            input.characterId, input.chatId, () => checkoutChat(input)
        )),
        seedWikiReboot: (input) => serializedMany([
            [input.characterId, input.sourceChatId],
            [input.characterId, input.stagingChatId],
        ], async () => {
            if (!input.stagingChatId.startsWith('reboot-') || input.stagingChatId === input.sourceChatId) {
                throw new Error('Invalid Wiki reboot staging destination')
            }
            await ensureWikiRecovered(input.characterId, input.sourceChatId)
            return versioning.fork({
                characterId: input.characterId, sourceChatId: input.sourceChatId,
                destinationChatId: input.stagingChatId, commitId: input.commitId,
            })
        }),
        wikiFork: (input) => withChatTransition(input.characterId, input.destinationChatId, () => serializedMany([
            [input.characterId, input.sourceChatId],
            [input.characterId, input.destinationChatId],
        ], async () => {
            const next = decodeChatSnapshot(input.chatBase64, input.destinationChatId)
            await ensureWikiRecovered(input.characterId, input.sourceChatId)
            await options.beforeChatTransition?.()
            const link = await repository.readLink(input.characterId, input.destinationChatId)
            if (link?.chatId === input.destinationChatId) {
                const completed = await repository.readOperationReceipt({
                    ...input, chatId: input.destinationChatId,
                })
                let chatExists = false
                try { canonical().loadChat(input.characterId, input.destinationChatId); chatExists = true }
                catch (error) { if (error.code !== 'ENOENT') throw error }
                if (!completed && (chatExists || link.originChatId !== input.sourceChatId)) {
                    throw new Error('Wiki fork destination already exists')
                }
            }
            else await versioning.fork(input)
            return checkoutChat({
                characterId: input.characterId,
                chatId: input.destinationChatId,
                commitId: input.commitId,
                operationId: input.operationId,
                chatBase64: input.chatBase64,
                reason: 'fork',
            }, next)
        })),
        deletedWikiRecovery: (input) => serialized(
            input.characterId,
            '@recovery',
            () => repository.listDeletedRecovery(input.characterId)
        ),
        discardWikiFork: (input) => serialized(
            input.characterId,
            input.chatId,
            () => repository.discardChatBranch(input.characterId, input.chatId)
        ),
        wikiRefs: (input) => serialized(
            input.characterId,
            input.chatId,
            () => input.kind
                ? versioning.listRefs(input)
                : versioning.listRefsForChat(input.characterId, input.chatId)
        ),
        createWikiRef: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => {
                const chatStateRef = input.chatBase64
                    ? await repository.storeChatState({
                        characterId: input.characterId,
                        chatId: input.chatId,
                        contents: input.chatBase64,
                    })
                    : undefined
                return versioning.createRef({
                    ...input,
                    ...(chatStateRef ? { chatStateRef } : {}),
                })
            }
        ),
        readWikiRecovery: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => {
                const refs = await versioning.listRefs({
                    ...input, kind: 'recovery',
                })
                const ref = refs.find((record) => record.id === input.id)
                if (!ref?.chatStateRef) {
                    throw new Error('Wiki recovery chat state is missing')
                }
                const chatBase64 = await repository.readChatState({
                    characterId: input.characterId,
                    chatId: input.chatId,
                    hash: ref.chatStateRef,
                })
                if (chatBase64 === null) {
                    throw new Error('Wiki recovery chat state is missing')
                }
                return { ref, chatBase64 }
            }
        ),
        deleteWikiRef: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => {
                const deleted = (await versioning.listRefs(input))
                    .find((ref) => ref.id === input.id)
                await versioning.deleteRef(input)
                if (deleted?.reason === 'chat-delete') {
                    const remaining = await versioning.listRefs({
                        ...input, kind: 'recovery',
                    })
                    const canonical = require('./db.cjs').repository.loadChat(
                        input.characterId, input.chatId
                    )
                    if (!canonical && remaining.length === 0) {
                        await repository.discardChatBranch(
                            input.characterId, input.chatId
                        )
                    }
                }
                await repository.collectChatState({
                    characterId: input.characterId,
                    chatId: input.chatId,
                    referencedHashes: await memorySaveChatStateRoots({
                        userDataDirectory, characterId: input.characterId,
                    }),
                })
                return repository.collectGarbage({
                    characterId: input.characterId,
                    chatId: input.chatId,
                })
            }
        ),
        wikiCommitPathMap: (input) => serialized(
            input.characterId,
            input.chatId,
            () => versioning.readPathMap(
                input.characterId, input.chatId, input.commitId
            )
        ),
        findWikiCommitByPrefix: (input) => serialized(
            input.characterId,
            input.chatId,
            () => versioning.findCommitForPrefixes(input)
        ),
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
