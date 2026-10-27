import * as fs from 'node:fs/promises'
import * as syncFs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import fileStore from './file-store.cjs'
import type {
    StoryBackupSummary, StoryBeginWikiInput, StoryCaptureInput, StoryChatDelta,
    StoryCheckoutInput, StoryCompleteCheckoutInput, StoryFinishWikiInput,
    StoryHistoryIdentity, StoryHistoryState,
} from '../../src/ts/risubard/storyHistoryTypes'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import { completeMemoryWorkspaceFork, replaceMemoryWorkspace } from './risubard-memory-fork'
import {
    assertSafeSaveStorePath, parseSavedFiles, putSaveBlob, readSaveBlob,
    restoreWorkspaceFromStore, serializeSavedFiles, snapshotWorkspaceToStore,
} from './risubard-memory-save-store'
import type { SavedFileEntry } from './risubard-memory-save-store'

const { atomicWriteJson, readVerifiedJson } = fileStore
const HASH = /^[0-9a-f]{64}$/
const historyLanes = new Map<string, Promise<void>>()

function inHistoryLane<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (historyLanes.get(key) ?? Promise.resolve()).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    historyLanes.set(key, settled)
    void settled.then(() => {
        if (historyLanes.get(key) === settled) historyLanes.delete(key)
    })
    return result
}

type Snapshot = { messages: Array<{ id: string; hash: string; isTurn: boolean; isActive: boolean }>; stateHash: string }

function latestActiveMessageId(snapshot: Snapshot): string | null {
    for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
        if (snapshot.messages[index].isActive) return snapshot.messages[index].id
    }
    return null
}
type Backup = StoryBackupSummary & { bindingsHash: string }
type WikiCommit = {
    id: string; parentCommitId: string | null; createdAt: string; reason: string
    wikiManifestHash: string; sourceChatSnapshotId: string | null
    sourceMessageIds: string[]; targetMessageId: string | null
}
type CheckoutRecord = {
    backup: Backup; chatSnapshotId: string; bindings: Record<string, string>
    wikiCommitId: string; branchId: string; anchorMessageId: string | null
}
type Stored = {
    schemaVersion: 1; characterId: string; chatId: string; state: StoryHistoryState
    records: Record<string, Backup>; commits: Record<string, WikiCommit>
    labels: Record<string, string>
    pinnedHashes: string[]; operations: Record<string, { kind: string; id: string }>
    checkout?: CheckoutRecord; completedCheckouts: Record<string, 'finalize' | 'discard'>
    recovery?: { forkToken: string; manifestHash: string }
    recoveredWikiOperationId?: string
}
export interface StoryHistoryPreview {
    backup: StoryBackupSummary
    chat: Record<string, unknown>
    wikiFiles: SavedFileEntry[]
    documents?: Array<{ path: string; content: string }>
}
export interface StoryPreparedCheckout {
    chat: Record<string, unknown>
    forkToken: string
    state: StoryHistoryState
    destinationChatId: string
    sourceChatId: string
}
export interface StoryLegacyImport extends StoryHistoryIdentity {
    operationId: string
    imports: Array<{
        legacySaveId: string; chat: Record<string, unknown>; wikiFiles: SavedFileEntry[]
        createdAt: string; name?: string; originalBackupId?: string
    }>
    currentChat: Record<string, unknown>
}
export interface StoryHistoryExport {
    state: StoryHistoryState
    backups: StoryHistoryPreview[]
    currentChat: Record<string, unknown>
    currentWikiFiles: SavedFileEntry[]
}
export interface StoryHistoryService {
    status(input: StoryHistoryIdentity): Promise<StoryHistoryState>
    capture(input: StoryCaptureInput): Promise<StoryHistoryState>
    beginWiki(input: StoryBeginWikiInput): Promise<StoryHistoryState>
    finishWiki(input: StoryFinishWikiInput): Promise<StoryHistoryState>
    commitManualWiki(input: StoryHistoryIdentity & { operationId?: string; reason?: string }): Promise<StoryHistoryState>
    assertWritable(input: StoryHistoryIdentity, options?: { operationId?: string }): Promise<void>
    prepareCheckout(input: StoryCheckoutInput): Promise<StoryPreparedCheckout>
    completeCheckout(input: StoryCompleteCheckoutInput): Promise<StoryHistoryState>
    recoverCheckout(input: StoryHistoryIdentity): Promise<StoryPreparedCheckout | null>
    listPendingCheckouts(): Promise<StoryHistoryIdentity[]>
    preview(input: StoryHistoryIdentity & { backupId: string; sourceOperationId?: string }): Promise<StoryHistoryPreview>
    rename(input: StoryHistoryIdentity & { backupId: string; name: string; expectedRevision?: number; operationId?: string }): Promise<StoryHistoryState>
    setQuick(input: StoryHistoryIdentity & { backupId: string; expectedRevision?: number; operationId?: string }): Promise<StoryHistoryState>
    importLegacy(input: StoryLegacyImport): Promise<StoryHistoryState>
    exportHistory(input: StoryHistoryIdentity): Promise<StoryHistoryExport>
    deactivate(input: StoryHistoryIdentity & { operationId: string }): Promise<StoryHistoryState>
}

function required(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
        throw new Error(`Invalid story history ${label}`)
    }
    return value
}
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}
/** Canonical JSON omits optional undefined fields and turns undefined array entries into null. */
function encode(value: unknown): string {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
    if (Array.isArray(value)) return `[${Array.from(value, item => item === undefined ? 'null' : encode(item)).join(',')}]`
    if (record(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
        return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${encode(value[key])}`).join(',')}}`
    }
    throw new Error('Story history requires JSON values')
}
function empty(): StoryHistoryState {
    return {
        mode: 'legacy', revision: 0, epoch: 0, headId: null, branchId: null,
        wikiCommitId: null, workingSnapshotId: null, quickSaveId: null,
        anchorMessageId: null, bindings: {}, pendingWiki: null, pendingCheckout: null,
        branches: [], backups: [],
    }
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) }

/**
 * Asset GC visits retained JSON content without materializing duplicate chats.
 * Legacy-mode archives remain roots: rollback never releases their assets.
 */
export function visitRetainedStoryContent(
    userDataDirectory: string,
    visitor: (value: Record<string, unknown>) => void
): void {
    const safeDirectory = (path: string) => {
        const boundary = resolve(userDataDirectory)
        const relation = relative(boundary, resolve(path))
        if (relation === '..' || relation.startsWith('../') || relation.startsWith('..\\') || isAbsolute(relation)) {
            throw new Error('Story history asset path escapes its root')
        }
        let cursor = resolve(path)
        while (true) {
            if (syncFs.existsSync(cursor)) {
                const status = syncFs.lstatSync(cursor)
                if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Story history asset path is unsafe')
            }
            const parent = dirname(cursor)
            if (cursor === boundary) break
            cursor = parent
        }
    }
    const characters = join(userDataDirectory, 'risubard', 'characters')
    safeDirectory(characters)
    if (!syncFs.existsSync(characters)) return
    for (const character of syncFs.readdirSync(characters, { withFileTypes: true })) {
        if (!character.isDirectory() || character.isSymbolicLink()) throw new Error('Story history character path is unsafe')
        const histories = join(characters, character.name, 'story-history')
        safeDirectory(histories)
        if (!syncFs.existsSync(histories)) continue
        const store = join(characters, character.name, 'save-store')
        safeDirectory(store)
        const seenContent = new Set<string>()
        const seenSnapshots = new Set<string>()
        const readJson = (hash: string): unknown => {
            if (!HASH.test(hash)) throw new Error('Invalid retained story hash')
            const path = join(store, hash.slice(0, 2), hash)
            safeDirectory(dirname(path))
            const status = syncFs.lstatSync(path)
            if (!status.isFile() || status.isSymbolicLink()) throw new Error('Retained story blob is unsafe')
            const bytes = syncFs.readFileSync(path)
            if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Retained story blob is damaged')
            return JSON.parse(bytes.toString('utf8'))
        }
        for (const chat of syncFs.readdirSync(histories, { withFileTypes: true })) {
            if (!chat.isDirectory() || chat.isSymbolicLink()) throw new Error('Retained story state path is unsafe')
            const path = join(histories, chat.name, 'state.json')
            const status = syncFs.lstatSync(path)
            if (!status.isFile() || status.isSymbolicLink()) throw new Error('Retained story state is unsafe')
            const data = readVerifiedJson(userDataDirectory, relative(userDataDirectory, path)) as Stored
            if (data.schemaVersion !== 1 || !record(data.records) || !record(data.commits) || !record(data.state)) {
                throw new Error('Retained story state is damaged')
            }
            const snapshots = new Set(Object.values(data.records).map(value => value.chatSnapshotId))
            if (data.state.workingSnapshotId) snapshots.add(data.state.workingSnapshotId)
            if (data.state.pendingWiki) snapshots.add(data.state.pendingWiki.sourceChatSnapshotId)
            if (data.checkout) snapshots.add(data.checkout.chatSnapshotId)
            for (const commit of Object.values(data.commits)) {
                if (commit.sourceChatSnapshotId) snapshots.add(commit.sourceChatSnapshotId)
            }
            for (const hash of snapshots) {
                if (seenSnapshots.has(hash)) continue
                seenSnapshots.add(hash)
                const snapshot = readJson(hash) as Snapshot
                if (!Array.isArray(snapshot.messages) || !HASH.test(snapshot.stateHash)) throw new Error('Retained story snapshot is damaged')
                for (const contentHash of [snapshot.stateHash, ...snapshot.messages.map(value => value.hash)]) {
                    if (seenContent.has(contentHash)) continue
                    seenContent.add(contentHash)
                    const value = readJson(contentHash)
                    if (!record(value)) throw new Error('Retained story content is damaged')
                    visitor(value)
                }
            }
        }
    }
}

export function createStoryHistoryService(userDataDirectory: string): StoryHistoryService {
    const workspace = (input: StoryHistoryIdentity) => resolveMemoryWorkspace(
        userDataDirectory, required(input.characterId, 'characterId'), required(input.chatId, 'chatId')
    ).directory
    const characterRoot = (input: StoryHistoryIdentity) => dirname(dirname(workspace(input)))
    const store = (input: StoryHistoryIdentity) => join(characterRoot(input), 'save-store')
    const directory = (input: StoryHistoryIdentity) => join(characterRoot(input), 'story-history', `id-${Buffer.from(input.chatId).toString('base64url')}`)
    const statePath = (input: StoryHistoryIdentity) => join(directory(input), 'state.json')
    const pathInRoot = (input: StoryHistoryIdentity) => relative(userDataDirectory, statePath(input))
    const fresh = (input: StoryHistoryIdentity): Stored => ({
        schemaVersion: 1, characterId: input.characterId, chatId: input.chatId,
        state: empty(), records: {}, commits: {}, labels: {}, pinnedHashes: [],
        operations: Object.create(null), completedCheckouts: {},
    })
    const load = async (input: StoryHistoryIdentity): Promise<Stored> => {
        await assertSafeSaveStorePath(fs, directory(input), userDataDirectory)
        let found = false
        try {
            const status = await fs.lstat(statePath(input))
            found = true
            if (!status.isFile() || status.isSymbolicLink()) throw new Error('Story history state is unsafe')
            const checksumStatus = await fs.lstat(`${statePath(input)}.sha256`)
            if (!checksumStatus.isFile() || checksumStatus.isSymbolicLink()) throw new Error('Story history checksum is unsafe')
            const value = readVerifiedJson(userDataDirectory, pathInRoot(input)) as Stored
            if (value.schemaVersion !== 1 || value.characterId !== input.characterId || value.chatId !== input.chatId
                || !record(value.records) || !record(value.commits) || !Array.isArray(value.pinnedHashes)
                || value.pinnedHashes.some(hash => !HASH.test(hash)) || !record(value.state)
                || !record(value.operations) || !record(value.completedCheckouts)) {
                throw new Error('Story history state is damaged')
            }
            value.labels ??= {}
            value.state.bindings = Object.assign(Object.create(null), value.state.bindings)
            value.operations = Object.assign(Object.create(null), value.operations)
            if (value.recovery || (value.state.pendingWiki
                && value.state.pendingWiki.status !== 'writing'
                && value.recoveredWikiOperationId !== value.state.pendingWiki.operationId)) {
                const pending = value.state.pendingWiki
                if (!pending) throw new Error('Wiki recovery has no pending operation')
                await restoreWiki(input, value, pending.recoveryManifestHash)
                value.recoveredWikiOperationId = pending.operationId
                await save(input, value)
            }
            return value
        }
        catch (error) {
            if (!found && (error as NodeJS.ErrnoException).code === 'ENOENT') return fresh(input)
            throw error
        }
    }
    const save = async (input: StoryHistoryIdentity, data: Stored): Promise<StoryHistoryState> => {
        await assertSafeSaveStorePath(fs, directory(input), userDataDirectory)
        for (const suffix of ['', '.sha256', '.bak']) {
            try {
                const status = await fs.lstat(`${statePath(input)}${suffix}`)
                if (!status.isFile() || status.isSymbolicLink()) throw new Error('Story history state path is unsafe')
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
        }
        data.state.revision += 1
        data.state.backups = Object.values(data.records).map(({ bindingsHash: _, ...backup }) =>
            ({ ...backup, ...(data.labels[backup.id] !== undefined ? { name: data.labels[backup.id] } : {}) }))
        atomicWriteJson(userDataDirectory, pathInRoot(input), data)
        return clone(data.state)
    }
    const active = (data: Stored) => {
        if (data.state.mode !== 'history') throw new Error('Story history requires explicit migration')
    }
    const revision = (data: Stored, expected?: number) => {
        if (expected !== undefined && expected !== data.state.revision) throw new Error('Story history revision conflict')
    }
    const writable = (data: Stored, operationId?: string) => {
        if (data.state.pendingCheckout) throw new Error('Story history checkout is pending')
        const pending = data.state.pendingWiki
        if (pending && (pending.operationId !== operationId || pending.status !== 'writing')) {
            throw new Error('Story wiki confirmation is pending')
        }
    }
    const pinSets = new WeakMap<Stored, Set<string>>()
    const pin = (data: Stored, hash: string) => {
        let hashes = pinSets.get(data)
        if (!hashes) {
            hashes = new Set(data.pinnedHashes)
            pinSets.set(data, hashes)
        }
        if (!hashes.has(hash)) {
            hashes.add(hash)
            data.pinnedHashes.push(hash)
        }
    }
    const put = async (input: StoryHistoryIdentity, data: Stored, value: unknown) => {
        const hash = await putSaveBlob(fs, store(input), Buffer.from(encode(value)))
        pin(data, hash)
        return hash
    }
    const get = async <T>(input: StoryHistoryIdentity, hash: string): Promise<T> =>
        JSON.parse((await readSaveBlob(fs, store(input), hash)).toString('utf8'))
    const snapshotWiki = async (input: StoryHistoryIdentity, data: Stored) => {
        await assertSafeSaveStorePath(fs, workspace(input), userDataDirectory)
        let exists = true
        try { await fs.lstat(workspace(input)) }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            exists = false
        }
        const files = exists ? await snapshotWorkspaceToStore(fs, workspace(input), store(input)) : []
        for (const file of files) pin(data, file.hash)
        return put(input, data, files)
    }
    const wikiFiles = async (input: StoryHistoryIdentity, data: Stored, commitId: string) => {
        const commit = data.commits[commitId]
        if (!commit) throw new Error('Story wiki commit not found')
        return parseSavedFiles(serializeSavedFiles(await get<SavedFileEntry[]>(input, commit.wikiManifestHash)))
    }
    const materialize = async (input: StoryHistoryIdentity, hash: string) => {
        const snapshot = await get<Snapshot>(input, hash)
        const state = await get<Record<string, unknown>>(input, snapshot.stateHash)
        const messages = await Promise.all(snapshot.messages.map(async entry => {
            const value = await get<Record<string, unknown>>(input, entry.hash)
            if (!record(value) || value.chatId !== entry.id) throw new Error('Story message blob is damaged')
            return value
        }))
        return { ...state, id: input.chatId, message: messages }
    }
    const makeSnapshot = async (input: StoryHistoryIdentity, data: Stored, delta: StoryChatDelta, enforceBase: boolean) => {
        if (!record(delta) || !Array.isArray(delta.order) || !Array.isArray(delta.messages) || !record(delta.state)
            || 'message' in delta.state || 'messages' in delta.state) throw new Error('Invalid story chat delta')
        if (enforceBase && delta.baseSnapshotId !== data.state.workingSnapshotId) throw new Error('Story chat delta base conflict')
        const order = new Set<string>()
        for (const id of delta.order) {
            required(id, 'message ID')
            if (order.has(id)) throw new Error('Duplicate story message ID')
            order.add(id)
        }
        const previous = delta.baseSnapshotId ? await get<Snapshot>(input, delta.baseSnapshotId) : null
        const hashes = new Map(previous?.messages.map(entry => [entry.id, entry]) ?? [])
        const changed = new Set<string>()
        for (const entry of delta.messages) {
            if (!record(entry) || !order.has(entry.id) || changed.has(entry.id)
                || !record(entry.value) || entry.value.chatId !== entry.id) throw new Error('Invalid changed story message')
            if ('risubardStoryBinding' in entry.value) throw new Error('Story bindings must not be embedded in message content')
            changed.add(entry.id)
            hashes.set(entry.id, {
                id: entry.id, hash: await put(input, data, entry.value),
                isTurn: entry.value.role === 'char' && !entry.value.isComment && !entry.value.disabled,
                isActive: !entry.value.isComment && !entry.value.disabled,
            })
        }
        const messages = delta.order.map(id => {
            const entry = hashes.get(id)
            if (!entry) throw new Error('Story chat delta omitted a new message')
            return entry
        })
        const stateHash = await put(input, data, delta.state)
        return put(input, data, { messages, stateHash })
    }
    const fullDelta = (chat: Record<string, unknown>): StoryChatDelta => {
        if (!record(chat) || !Array.isArray(chat.message)) throw new Error('Invalid imported story chat')
        const { message, ...state } = chat
        const messages = message.map(value => {
            if (!record(value)) throw new Error('Invalid imported story message')
            return { id: required(value.chatId, 'message ID'), value }
        })
        return { baseSnapshotId: null, state, order: messages.map(entry => entry.id), messages }
    }
    const commit = async (input: StoryHistoryIdentity, data: Stored, manifestHash: string, reason: string,
        sourceChatSnapshotId: string | null = null, sourceMessageIds: string[] = [], targetMessageId: string | null = null) => {
        const value: WikiCommit = {
            id: randomUUID(), parentCommitId: data.state.wikiCommitId, createdAt: new Date().toISOString(),
            wikiManifestHash: manifestHash, reason, sourceChatSnapshotId, sourceMessageIds, targetMessageId,
        }
        data.commits[value.id] = value
        data.state.wikiCommitId = value.id
        return value.id
    }
    const branchForMutation = (data: Stored) => {
        const branch = data.state.branches.find(item => item.id === data.state.branchId)
        if (!branch || branch.tipId !== data.state.headId) data.state.branchId = randomUUID()
        return data.state.branchId as string
    }
    const backup = async (input: StoryHistoryIdentity, data: Stored, snapshotId: string,
        kind: StoryBackupSummary['kind'], anchor: string | null, options: { root?: boolean; createdAt?: string; name?: string } = {}) => {
        const branchId = options.root ? randomUUID() : branchForMutation(data)
        const snapshot = await get<Snapshot>(input, snapshotId)
        const latest = latestActiveMessageId(snapshot)
        const value: Backup = {
            id: randomUUID(), parentId: options.root ? null : data.state.headId, branchId,
            wikiCommitId: required(data.state.wikiCommitId, 'wiki commit'), chatSnapshotId: snapshotId,
            bindingsHash: await put(input, data, data.state.bindings), kind, anchorMessageId: anchor,
            latestMessageId: latest, createdAt: options.createdAt ?? new Date().toISOString(),
            turnCount: snapshot.messages.filter(entry => entry.isTurn).length, ...(options.name ? { name: options.name } : {}),
        }
        data.records[value.id] = value
        const ref = data.state.branches.find(item => item.id === branchId)
        if (ref) ref.tipId = value.id
        else data.state.branches.push({ id: branchId, tipId: value.id })
        data.state.headId = value.id
        data.state.branchId = branchId
        return value
    }
    const checkedBackup = (data: Stored, id: string) => {
        const value = data.records[required(id, 'backup ID')]
        if (!value) throw new Error('Story backup not found')
        return value
    }
    const restoreWiki = async (input: StoryHistoryIdentity, data: Stored, manifestHash: string) => {
        if (data.recovery) {
            if (data.recovery.manifestHash !== manifestHash) throw new Error('Different wiki recovery is pending')
        }
        else {
            const files = parseSavedFiles(serializeSavedFiles(await get<SavedFileEntry[]>(input, manifestHash)))
            const fork = await replaceMemoryWorkspace({
                userDataDirectory, characterId: input.characterId,
                sourceChatId: `history-recovery:${randomUUID()}`, destinationChatId: input.chatId,
            }, { populate: staging => restoreWorkspaceFromStore(fs, files, store(input), staging) })
            data.recovery = { forkToken: fork.forkToken, manifestHash }
            await save(input, data)
        }
        await completeMemoryWorkspaceFork({
            userDataDirectory, characterId: input.characterId, destinationChatId: input.chatId,
            forkToken: data.recovery.forkToken, action: 'finalize',
        })
        delete data.recovery
    }
    const preview = async (input: StoryHistoryIdentity & { backupId: string; sourceOperationId?: string }): Promise<StoryHistoryPreview> => {
        const data = await load(input)
        const value = checkedBackup(data, input.backupId)
        const { bindingsHash: _, ...summary } = value
        let chatSnapshotId = value.chatSnapshotId
        if (input.sourceOperationId) {
            const pending = data.state.pendingWiki
            if (!pending || pending.operationId !== input.sourceOperationId || pending.sourceBackupId !== value.id) {
                throw new Error('Pending story wiki source does not match')
            }
            chatSnapshotId = pending.sourceChatSnapshotId
        }
        const files = await wikiFiles(input, data, value.wikiCommitId)
        const documents: Array<{ path: string; content: string }> = []
        let remaining = 4 * 1024 * 1024
        for (const file of files) {
            if (!/\.(md|markdown|txt|json|jsonl)$/i.test(file.path) || file.size > Math.min(remaining, 1024 * 1024)) continue
            documents.push({ path: file.path, content: (await readSaveBlob(fs, store(input), file.hash)).toString('utf8') })
            remaining -= file.size
        }
        return {
            backup: clone({ ...summary, ...(data.labels[value.id] !== undefined ? { name: data.labels[value.id] } : {}) }),
            chat: await materialize(input, chatSnapshotId), wikiFiles: files, documents,
        }
    }
    const recoverCheckout = async (input: StoryHistoryIdentity): Promise<StoryPreparedCheckout | null> => {
        const data = await load(input)
        const pending = data.state.pendingCheckout
        if (!pending || !data.checkout) return null
        return {
            chat: { ...await materialize(input, data.checkout.chatSnapshotId), id: pending.destinationChatId },
            forkToken: pending.forkToken, state: clone(data.state),
            destinationChatId: pending.destinationChatId, sourceChatId: pending.sourceChatId,
        }
    }

    const service: StoryHistoryService = {
        async status(input) { return clone((await load(input)).state) },
        async assertWritable(input, options = {}) { writable(await load(input), options.operationId) },
        async capture(input) {
            const data = await load(input)
            active(data)
            required(input.operationId, 'operation ID')
            const previous = data.operations[input.operationId]
            if (previous) {
                if (previous.kind !== 'capture') throw new Error('Story operation ID reused')
                return clone(data.state)
            }
            revision(data, input.expectedRevision)
            if (data.state.pendingCheckout) throw new Error('Story checkout is pending')
            if (!['working', 'chat-edit', 'manual'].includes(input.kind)) throw new Error('Invalid story capture kind')
            const snapshotId = await makeSnapshot(input, data, input.delta, true)
            const snapshot = await get<Snapshot>(input, snapshotId)
            const anchor = input.anchorMessageId ?? latestActiveMessageId(snapshot)
            if (anchor && !snapshot.messages.some(entry => entry.id === anchor)) throw new Error('Story capture anchor is missing')
            data.state.workingSnapshotId = snapshotId
            const value = await backup(input, data, snapshotId, input.kind, anchor)
            data.operations[input.operationId] = { kind: 'capture', id: value.id }
            return save(input, data)
        },
        async beginWiki(input) {
            const data = await load(input)
            active(data)
            required(input.operationId, 'operation ID')
            const completed = data.operations[input.operationId]
            if (completed) {
                if (completed.kind !== 'wiki') throw new Error('Story operation ID reused')
                return clone(data.state)
            }
            const pending = data.state.pendingWiki
            if (pending) {
                if (pending.operationId !== input.operationId || pending.targetMessageId !== input.targetMessageId) {
                    throw new Error('Another story wiki confirmation is pending')
                }
                await restoreWiki(input, data, pending.recoveryManifestHash)
                pending.status = 'writing'
                delete pending.error
                delete data.recoveredWikiOperationId
                return save(input, data)
            }
            revision(data, input.expectedRevision)
            writable(data)
            const target = required(input.targetMessageId, 'wiki target')
            const ancestry: Backup[] = []
            let cursor = data.state.headId
            while (cursor) {
                const ancestor: Backup = checkedBackup(data, cursor)
                ancestry.push(ancestor)
                cursor = ancestor.parentId
            }
            const source = input.sourceBackupId ? ancestry.find(value => value.id === input.sourceBackupId)
                : ancestry.find(value => value.latestMessageId === target
                    && ['working', 'chat-edit', 'manual', 'import'].includes(value.kind))
            if (!source || source.latestMessageId !== target) throw new Error('Completed target-turn capture not found')
            const original = await get<Snapshot>(input, source.chatSnapshotId)
            if (!Array.isArray(input.sourceMessageIds) || input.sourceMessageIds.some(id =>
                typeof id !== 'string' || !id.trim() || id.length > 4096)
                || new Set(input.sourceMessageIds).size !== input.sourceMessageIds.length) throw new Error('Invalid story wiki source IDs')
            const current = data.state.workingSnapshotId ? await get<Snapshot>(input, data.state.workingSnapshotId) : original
            const currentHashes = new Map(current.messages.map(entry => [entry.id, entry]))
            const projected = new Set([...input.sourceMessageIds, target])
            const sourceChatSnapshotId = await put(input, data, {
                stateHash: original.stateHash,
                messages: original.messages.map(entry => projected.has(entry.id) && currentHashes.has(entry.id)
                    ? currentHashes.get(entry.id) : entry),
            })
            const recoveryManifestHash = await snapshotWiki(input, data)
            data.state.pendingWiki = {
                operationId: input.operationId, sourceBackupId: source.id, sourceChatSnapshotId,
                targetMessageId: target, sourceMessageIds: [...input.sourceMessageIds], recoveryManifestHash,
                parentCommitId: required(data.state.wikiCommitId, 'wiki commit'), epoch: data.state.epoch, status: 'writing',
            }
            return save(input, data)
        },
        async finishWiki(input) {
            const data = await load(input)
            active(data)
            if (data.operations[input.operationId]?.kind === 'wiki') return clone(data.state)
            const pending = data.state.pendingWiki
            if (!pending || pending.operationId !== input.operationId) throw new Error('Story wiki operation does not match')
            if (pending.epoch !== data.state.epoch) throw new Error('Story wiki operation epoch conflict')
            if (!['applied', 'unchanged', 'kept', 'failed', 'cancelled'].includes(input.outcome)) throw new Error('Invalid wiki outcome')
            if (input.outcome === 'failed' || input.outcome === 'cancelled') {
                pending.status = input.outcome
                if (input.error) pending.error = String(input.error).slice(0, 4096)
                delete data.recoveredWikiOperationId
                await save(input, data)
                await restoreWiki(input, data, pending.recoveryManifestHash)
                data.recoveredWikiOperationId = pending.operationId
                return save(input, data)
            }
            if (pending.status !== 'writing' && input.outcome !== 'kept') throw new Error('Story wiki operation requires retry')
            if (input.outcome === 'kept') await restoreWiki(input, data, pending.recoveryManifestHash)
            const manifestHash = input.outcome === 'kept' ? pending.recoveryManifestHash : await snapshotWiki(input, data)
            const commitId = await commit(input, data, manifestHash, input.outcome,
                pending.sourceChatSnapshotId, pending.sourceMessageIds, pending.targetMessageId)
            data.state.bindings[pending.targetMessageId] = commitId
            data.state.anchorMessageId = pending.targetMessageId
            const value = await backup(input, data, pending.sourceChatSnapshotId, 'turn', pending.targetMessageId)
            // The turn's load boundary is frozen, but a later working chat must survive.
            data.state.pendingWiki = null
            data.operations[input.operationId] = { kind: 'wiki', id: value.id }
            return save(input, data)
        },
        async commitManualWiki(input) {
            const data = await load(input)
            if (data.state.mode === 'legacy') return clone(data.state)
            writable(data)
            const operationId = input.operationId ?? randomUUID()
            if (data.operations[operationId]) {
                if (data.operations[operationId].kind !== 'manual-wiki') throw new Error('Story operation ID reused')
                return clone(data.state)
            }
            const snapshotId = required(data.state.workingSnapshotId, 'working snapshot')
            const commitId = await commit(input, data, await snapshotWiki(input, data), input.reason ?? 'manual',
                null, [], data.state.anchorMessageId)
            const anchor = data.state.anchorMessageId
            if (anchor) data.state.bindings[anchor] = commitId
            const value = await backup(input, data, snapshotId, 'wiki-edit', anchor)
            data.operations[operationId] = { kind: 'manual-wiki', id: value.id }
            return save(input, data)
        },
        preview,
        async prepareCheckout(input) {
            const source = await load(input)
            active(source)
            revision(source, input.expectedRevision)
            writable(source)
            const value = checkedBackup(source, input.backupId)
            const destinationChatId = input.asNewChat ? required(input.destinationChatId, 'destination chat ID') : input.chatId
            if (input.asNewChat && destinationChatId === input.chatId) throw new Error('Copy requires a different chat ID')
            const destination = { characterId: input.characterId, chatId: destinationChatId }
            const existing = destinationChatId === input.chatId ? source : await load(destination)
            writable(existing)
            if (destinationChatId !== input.chatId && existing.state.mode === 'history') throw new Error('Destination story history already exists')
            const data = destinationChatId === input.chatId ? source : clone(source)
            data.chatId = destinationChatId
            data.state.pendingWiki = null
            const files = await wikiFiles(input, source, value.wikiCommitId)
            const fork = await replaceMemoryWorkspace({
                userDataDirectory, characterId: input.characterId,
                sourceChatId: `history-checkout:${randomUUID()}`, destinationChatId,
            }, { populate: staging => restoreWorkspaceFromStore(fs, files, store(input), staging) })
            data.state.pendingCheckout = { forkToken: fork.forkToken, sourceChatId: input.chatId, destinationChatId, backupId: value.id }
            data.checkout = {
                backup: value, chatSnapshotId: value.chatSnapshotId,
                bindings: await get<Record<string, string>>(input, value.bindingsHash),
                wikiCommitId: value.wikiCommitId, branchId: value.branchId,
                anchorMessageId: source.commits[value.wikiCommitId]?.targetMessageId ?? null,
            }
            await save(destination, data)
            return (await recoverCheckout(destination)) as StoryPreparedCheckout
        },
        async completeCheckout(input) {
            const destination = { characterId: input.characterId, chatId: input.destinationChatId ?? input.chatId }
            const data = await load(destination)
            const completed = data.completedCheckouts[input.forkToken]
            if (completed) {
                if (completed !== input.action) throw new Error('Checkout already completed differently')
                return clone(data.state)
            }
            const pending = data.state.pendingCheckout
            if (!pending || pending.forkToken !== input.forkToken || !data.checkout) throw new Error('Story checkout token does not match')
            await completeMemoryWorkspaceFork({
                userDataDirectory, characterId: input.characterId, destinationChatId: destination.chatId,
                forkToken: input.forkToken, action: input.action,
            })
            if (input.action === 'finalize') {
                data.state.headId = data.checkout.backup.id
                data.state.branchId = data.checkout.branchId
                data.state.workingSnapshotId = data.checkout.chatSnapshotId
                data.state.wikiCommitId = data.checkout.wikiCommitId
                data.state.bindings = data.checkout.bindings
                data.state.anchorMessageId = data.checkout.anchorMessageId
                data.state.epoch += 1
            }
            else if (pending.sourceChatId !== pending.destinationChatId) {
                data.state.mode = 'legacy'
            }
            data.state.pendingCheckout = null
            delete data.checkout
            data.completedCheckouts[input.forkToken] = input.action
            return save(destination, data)
        },
        recoverCheckout,
        async listPendingCheckouts() {
            const result: StoryHistoryIdentity[] = []
            const root = join(userDataDirectory, 'risubard', 'characters')
            await assertSafeSaveStorePath(fs, root, userDataDirectory)
            let characters
            try { characters = await fs.readdir(root, { withFileTypes: true }) }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
                throw error
            }
            for (const character of characters) {
                if (character.isSymbolicLink() || !character.isDirectory()) throw new Error('Story character path is unsafe')
                const histories = join(root, character.name, 'story-history')
                await assertSafeSaveStorePath(fs, histories, userDataDirectory)
                let chats
                try { chats = await fs.readdir(histories, { withFileTypes: true }) }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
                    throw error
                }
                for (const chat of chats) {
                    if (!chat.isDirectory() || chat.isSymbolicLink()) throw new Error('Story history path is unsafe')
                    const identity = {
                        characterId: Buffer.from(character.name.slice(3), 'base64url').toString('utf8'),
                        chatId: Buffer.from(chat.name.slice(3), 'base64url').toString('utf8'),
                    }
                    const pending = await inHistoryLane(characterRoot(identity), () => load(identity))
                    if (pending.state.pendingCheckout) result.push(identity)
                }
            }
            return result
        },
        async rename(input) {
            const data = await load(input)
            active(data)
            revision(data, input.expectedRevision)
            const value = checkedBackup(data, input.backupId)
            if (typeof input.name !== 'string' || input.name.length > 512) throw new Error('Invalid story backup name')
            // Names are mutable labels, not part of immutable content manifests.
            data.labels[value.id] = input.name
            return save(input, data)
        },
        async setQuick(input) {
            const data = await load(input)
            active(data)
            revision(data, input.expectedRevision)
            checkedBackup(data, input.backupId)
            data.state.quickSaveId = input.backupId
            return save(input, data)
        },
        async importLegacy(input) {
            const data = await load(input)
            required(input.operationId, 'operation ID')
            if (data.operations[input.operationId]?.kind === 'import') return clone(data.state)
            if (data.state.mode === 'history') throw new Error('Story history is already active')
            writable(data)
            for (const entry of input.imports) {
                if (entry.originalBackupId) {
                    checkedBackup(data, entry.originalBackupId)
                    continue
                }
                const files = parseSavedFiles(serializeSavedFiles(entry.wikiFiles))
                for (const file of files) {
                    const contents = await readSaveBlob(fs, store(input), file.hash)
                    if (contents.byteLength !== file.size) throw new Error('Imported wiki page size mismatch')
                    pin(data, file.hash)
                }
                if (!Number.isFinite(Date.parse(entry.createdAt))) throw new Error('Invalid imported backup time')
                const snapshotId = await makeSnapshot(input, data, fullDelta(entry.chat), false)
                data.state.wikiCommitId = null
                data.state.bindings = {}
                await commit(input, data, await put(input, data, files), 'import')
                await backup(input, data, snapshotId, 'import', null, { root: true, createdAt: entry.createdAt, name: entry.name ?? entry.legacySaveId })
            }
            data.state.bindings = {}
            data.state.wikiCommitId = null
            data.state.anchorMessageId = null
            const currentSnapshotId = await makeSnapshot(input, data, fullDelta(input.currentChat), false)
            await commit(input, data, await snapshotWiki(input, data), 'import-current')
            data.state.workingSnapshotId = currentSnapshotId
            await backup(input, data, currentSnapshotId, 'import', null, { root: true, name: 'Current chat at migration' })
            data.state.mode = 'history'
            data.state.epoch += 1
            data.operations[input.operationId] = { kind: 'import', id: data.state.headId as string }
            return save(input, data)
        },
        async exportHistory(input) {
            const data = await load(input)
            active(data)
            writable(data)
            const backups: StoryHistoryPreview[] = []
            for (const value of Object.values(data.records)) {
                const { bindingsHash: _, ...summary } = value
                backups.push({
                    backup: clone({ ...summary, ...(data.labels[value.id] !== undefined ? { name: data.labels[value.id] } : {}) }),
                    chat: await materialize(input, value.chatSnapshotId),
                    wikiFiles: await wikiFiles(input, data, value.wikiCommitId),
                })
            }
            return {
                state: clone(data.state), backups,
                currentChat: await materialize(input, required(data.state.workingSnapshotId, 'working snapshot')),
                currentWikiFiles: await wikiFiles(input, data, required(data.state.wikiCommitId, 'wiki commit')),
            }
        },
        async deactivate(input) {
            const data = await load(input)
            required(input.operationId, 'operation ID')
            if (data.operations[input.operationId]?.kind === 'deactivate') return clone(data.state)
            active(data)
            writable(data)
            data.state.mode = 'legacy'
            data.state.epoch += 1
            data.operations[input.operationId] = { kind: 'deactivate', id: data.state.headId ?? '' }
            return save(input, data)
        },
    }
    const methods = new Map<PropertyKey, unknown>()
    return new Proxy(service, {
        get(target, key) {
            const method = Reflect.get(target, key)
            if (typeof method !== 'function' || key === 'listPendingCheckouts') return method
            if (!methods.has(key)) {
                methods.set(key, (input: StoryHistoryIdentity, ...args: unknown[]) =>
                    inHistoryLane(characterRoot(input), () => Reflect.apply(method, target, [input, ...args])))
            }
            return methods.get(key)
        },
    })
}
