import * as nodeFs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { Packr, Unpackr } from 'msgpackr'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import {
    computeWikiPrefixDigests,
    computeWikiPrefixDigest,
    isWikiVcsTrackedPath,
    normalizeWikiVcsPath,
    WIKI_VCS_SCHEMA_VERSION,
    type WikiAnchorMessage,
    type WikiBranchRecord,
    type WikiChatAnchor,
    type WikiChatLink,
    type WikiCheckpointRecord,
    type WikiCheckoutPreview,
    type WikiCommitKind,
    type WikiCommitProvenance,
    type WikiCommitRecord,
    type WikiCommitRequest,
    type WikiHistoryEntry,
    type WikiOperationReceipt,
    type WikiPrefixCheckpoint,
    type WikiPublishChangesRequest,
    type WikiPublishChangesResult,
    type WikiRecoveryReason,
    type WikiRefKind,
    type WikiRefRecord,
} from '../../src/ts/risubard/wikiVcsContract'
/** A checkpoint is written once this many deltas accumulated past the last one. */
const CHECKPOINT_INTERVAL = 16
/** Bound retained materialized path maps; larger histories replay/checkpoint. */
const PATH_MAP_CACHE_LIMIT = 16
const REPOSITORY_DIRECTORY = 'wiki-vcs'
const LINK_FILE = 'wiki-vcs-link.json'
const WORKING_TREE_DIRECTORY = 'wiki'
const AUTOSAVE_STATE_DIRECTORY = 'chat-state'
const HASH_PATTERN = /^[a-f0-9]{64}$/
const PREFIX_DIGEST_PATTERN = /^[a-f0-9]{16}$/
const JOURNAL_FILE = 'journal.json'
const chatPacker = new Packr({ useRecords: false })
const chatUnpacker = new Unpackr({ useRecords: false, int64AsType: 'number' })

function parseChatStateManifest(contents: string): {
    schemaVersion: 2
    header: string
    messages: string[]
} | undefined {
    if (!contents.startsWith('{')) return undefined
    const value = JSON.parse(contents)
    if (value?.schemaVersion !== 2
        || !HASH_PATTERN.test(value.header)
        || !Array.isArray(value.messages)
        || !value.messages.every((hash: unknown) =>
            typeof hash === 'string' && HASH_PATTERN.test(hash))) {
        throw new Error('Invalid chunked chat state')
    }
    return value
}

/**
 * Durable record of an in-flight operation. It is written before any ref or
 * branch changes, so a crash mid-publish can be finished (or rolled back)
 * rather than leaving the working tree and the branch head disagreeing.
 */
interface WikiOperationJournal {
    schemaVersion: 1
    operationId: string
    characterId: string
    chatId: string
    branchId: string
    /** Branch head before the operation started. */
    previousHead: string | null
    /** Commit this operation publishes, computed before any write. */
    commitId: string
    mode?: 'commit' | 'baseline' | 'publish' | 'checkout'
    changedPaths: string[]
    /** Original disk state, used to distinguish replay from an edit after crash. */
    beforePaths?: Record<string, string | null>
    /** Desired disk state for every journaled path. */
    targetPaths?: Record<string, string | null>
    recoveryRefId?: string | null
    reason?: WikiRecoveryReason
    checkpointCreated: boolean
    prepared: boolean
    /** Written once the branch head points at the commit. */
    published: boolean
    createdAt: string
}

class WikiMaterializationConflictError extends Error {
    constructor(
        operationId: string,
        path: string,
        currentHash: string | null,
        beforeHash: string | null,
        targetHash: string | null
    ) {
        super(
            `Wiki operation pending: materialization conflict for ${path}; `
            + `found ${currentHash ?? 'absent'}, before `
            + `${beforeHash ?? 'absent'}, target ${targetHash ?? 'absent'}. `
            + 'Restore the path to the before or target contents and retry '
            + `recovery; operation ${operationId} remains pending.`
        )
        this.name = 'WikiMaterializationConflictError'
    }
}

function parseJournal(value: unknown): WikiOperationJournal | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined
    }
    const record = value as Partial<WikiOperationJournal>
    if (record.schemaVersion !== 1
        || typeof record.operationId !== 'string'
        || typeof record.characterId !== 'string'
        || typeof record.chatId !== 'string'
        || typeof record.branchId !== 'string'
        || !HASH_PATTERN.test(String(record.commitId))
        || (record.previousHead !== null
            && !HASH_PATTERN.test(String(record.previousHead)))
        || !Array.isArray(record.changedPaths)
        || typeof record.prepared !== 'boolean'
        || typeof record.published !== 'boolean'
        || typeof record.createdAt !== 'string') {
        return undefined
    }
    const parsePaths = (
        paths: Record<string, string | null> | undefined
    ): Record<string, string | null> | undefined => {
        if (paths === undefined) return undefined
        if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) {
            return undefined
        }
        const parsed: Record<string, string | null> = {}
        for (const [rawPath, hash] of Object.entries(paths)) {
            const path = normalizeWikiVcsPath(rawPath)
            if (!isWikiVcsTrackedPath(path)
                || (hash !== null && !HASH_PATTERN.test(String(hash)))) {
                return undefined
            }
            parsed[path] = hash
        }
        return parsed
    }
    const beforePaths = parsePaths(record.beforePaths)
    const targetPaths = parsePaths(record.targetPaths)
    if (record.mode !== undefined
        && !['commit', 'baseline', 'publish', 'checkout'].includes(record.mode)) {
        return undefined
    }
    if ((record.beforePaths !== undefined && !beforePaths)
        || (record.targetPaths !== undefined && !targetPaths)) return undefined
    return {
        schemaVersion: 1,
        operationId: record.operationId,
        characterId: record.characterId,
        chatId: record.chatId,
        branchId: record.branchId,
        previousHead: record.previousHead ?? null,
        commitId: record.commitId as string,
        mode: record.mode ?? 'commit',
        changedPaths: record.changedPaths.filter(
            (path): path is string => typeof path === 'string'
        ),
        ...(beforePaths ? { beforePaths } : {}),
        ...(targetPaths ? { targetPaths } : {}),
        ...(typeof record.recoveryRefId === 'string'
            || record.recoveryRefId === null
            ? { recoveryRefId: record.recoveryRefId } : {}),
        ...(typeof record.reason === 'string'
            ? { reason: record.reason as WikiRecoveryReason } : {}),
        checkpointCreated: record.checkpointCreated === true,
        prepared: record.prepared,
        published: record.published,
        createdAt: record.createdAt,
    }
}

type RepositoryFileSystem = Pick<
    typeof nodeFs,
    'lstat' | 'mkdir' | 'readdir' | 'readFile' | 'rename' | 'rm' | 'writeFile' | 'open'
>

export interface WikiVcsRepository {
    directory: string
    objectsDirectory: string
    commitsDirectory: string
    checkpointsDirectory: string
    branchesDirectory: string
    savesDirectory: string
    recoveryDirectory: string
    autosavesDirectory: string
    operationsDirectory: string
    formatFile: string
    workingTreeDirectory: string
    linkFile: string
    characterDirectory: string
    characterId: string
    chatId: string
}

export interface WikiVcsServiceOptions {
    fileSystem?: RepositoryFileSystem
    now?: () => Date
}

/**
 * The repository is owned by a character and shared by every chat that forked
 * from it. Each chat keeps its own working tree and branch.
 */
export function resolveWikiVcsRepository(
    userDataDirectory: string,
    characterId: string,
    chatId: string
): WikiVcsRepository {
    const memory = resolveMemoryWorkspace(userDataDirectory, characterId, chatId)
    const characterDirectory = dirname(memory.directory)
    const directory = join(characterDirectory, REPOSITORY_DIRECTORY)
    const refs = join(directory, 'refs')
    return {
        directory,
        objectsDirectory: join(directory, 'objects'),
        commitsDirectory: join(directory, 'commits'),
        checkpointsDirectory: join(directory, 'checkpoints'),
        branchesDirectory: join(refs, 'branches'),
        savesDirectory: join(refs, 'saves'),
        recoveryDirectory: join(refs, 'recovery'),
        autosavesDirectory: join(refs, 'autosaves'),
        operationsDirectory: join(directory, 'operations'),
        formatFile: join(directory, 'format.json'),
        workingTreeDirectory: join(memory.directory, WORKING_TREE_DIRECTORY),
        linkFile: join(memory.directory, LINK_FILE),
        characterDirectory,
        characterId,
        chatId,
    }
}

function requiredString(value: unknown, label: string, maximum = 4096): string {
    if (typeof value !== 'string' || value.trim().length === 0
        || value.length > maximum) {
        throw new Error(`${label} must be a non-empty bounded string`)
    }
    return value
}

function operationIdentifier(value: string): string {
    const id = requiredString(value, 'Operation ID', 1024)
    if (id === '.' || id === '..' || /[/\\\0]/u.test(id)) {
        throw new Error('Invalid Wiki operation ID')
    }
    return id
}

function hashBytes(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex')
}

function requireHash(value: unknown, label: string): string {
    if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
        throw new Error(`${label} must be a SHA-256 hash`)
    }
    return value
}

function blobPath(objectsDirectory: string, hash: string): string {
    const verified = requireHash(hash, 'Wiki blob hash')
    return join(objectsDirectory, verified.slice(0, 2), verified)
}

function commitPath(commitsDirectory: string, commitId: string): string {
    const verified = requireHash(commitId, 'Wiki commit ID')
    return join(commitsDirectory, `${verified}.json`)
}

/**
 * Reference IDs come from chat and save identifiers, so they are encoded
 * instead of embedded: a caller cannot escape the refs directory.
 */
function refPath(directory: string, id: string): string {
    return join(
        directory,
        `${Buffer.from(requiredString(id, 'Reference ID', 512), 'utf8')
            .toString('base64url')}.json`
    )
}

/** Commit IDs are content addressed; the ID field itself is excluded. */
function commitIdentity(payload: Omit<WikiCommitRecord, 'id'>): string {
    return hashBytes(JSON.stringify(payload))
}

async function syncDirectory(fileSystem: RepositoryFileSystem, directory: string): Promise<void> {
    if (process.platform === 'win32') return
    const handle = await fileSystem.open(directory, 'r')
    try { await handle.sync() }
    finally { await handle.close() }
}

async function writeFileAtomically(
    fileSystem: RepositoryFileSystem,
    file: string,
    contents: string
): Promise<void> {
    await fileSystem.mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
        await fileSystem.writeFile(temporary, contents, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
            flush: true,
        })
        await fileSystem.rename(temporary, file)
        await syncDirectory(fileSystem, dirname(file))
    }
    catch (error) {
        await fileSystem.rm(temporary, { force: true }).catch(() => undefined)
        throw error
    }
}

async function removeFileDurably(
    fileSystem: RepositoryFileSystem,
    file: string
): Promise<void> {
    await fileSystem.rm(file, { force: true })
    await syncDirectory(fileSystem, dirname(file))
}

/** Idempotent create: a concurrent writer may have published the same file. */
async function writeFileExclusive(
    fileSystem: RepositoryFileSystem,
    file: string,
    contents: string
): Promise<void> {
    await fileSystem.mkdir(dirname(file), { recursive: true })
    try {
        await fileSystem.writeFile(file, contents, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
            flush: true,
        })
        await syncDirectory(fileSystem, dirname(file))
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
        throw error
    }
}

async function readJson<T>(
    fileSystem: RepositoryFileSystem,
    file: string
): Promise<T | undefined> {
    try {
        return JSON.parse(await fileSystem.readFile(file, 'utf8')) as T
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
    }
}

async function readDirectory(
    fileSystem: RepositoryFileSystem,
    directory: string
): Promise<string[]> {
    try {
        return await fileSystem.readdir(directory)
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
    }
}

async function pathExists(
    fileSystem: RepositoryFileSystem,
    target: string
): Promise<boolean> {
    try {
        await fileSystem.lstat(target)
        return true
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
    }
}

const COMMIT_KINDS: readonly string[] = [
    'baseline', 'analysis', 'manual', 'admin', 'external',
    'rebuild', 'import', 'review', 'policy',
]
const COMMIT_PROVENANCE: readonly string[] = [
    'recorded', 'legacy-baseline', 'reconstructed',
]
const REF_KINDS: readonly string[] = ['save', 'recovery', 'autosave']

function parseCommitRecord(value: unknown): WikiCommitRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Wiki commit record must be an object')
    }
    const record = value as Partial<WikiCommitRecord>
    if (record.schemaVersion !== WIKI_VCS_SCHEMA_VERSION
        || !HASH_PATTERN.test(String(record.id))
        || (record.parent !== null && !HASH_PATTERN.test(String(record.parent)))
        || typeof record.operationId !== 'string'
        || !COMMIT_KINDS.includes(String(record.kind))
        || !Array.isArray(record.changes)
        || typeof record.createdAt !== 'string'
        || typeof record.chatAnchor !== 'object' || record.chatAnchor === null
        || typeof record.chatAnchor.sourceChatId !== 'string') {
        throw new Error('Invalid wiki commit record')
    }
    const anchor = record.chatAnchor
    const seenPaths = new Set<string>()
    const changes = record.changes.map((change) => {
        if (typeof change !== 'object' || change === null
            || typeof change.path !== 'string'
            || (change.before !== null && !HASH_PATTERN.test(String(change.before)))
            || (change.after !== null && !HASH_PATTERN.test(String(change.after)))) {
            throw new Error('Invalid wiki commit change')
        }
        const path = normalizeWikiVcsPath(change.path)
        if (!isWikiVcsTrackedPath(path) || seenPaths.has(path)) {
            throw new Error('Invalid wiki commit change path')
        }
        seenPaths.add(path)
        return {
            path,
            before: change.before ?? null,
            after: change.after ?? null,
        }
    })
    const parsed: WikiCommitRecord = {
        schemaVersion: 1,
        id: record.id as string,
        parent: record.parent ?? null,
        operationId: record.operationId,
        kind: record.kind as WikiCommitKind,
        changes,
        chatAnchor: {
            sourceChatId: anchor.sourceChatId,
            boundaryMessageId: typeof anchor.boundaryMessageId === 'string'
                && anchor.boundaryMessageId.length > 0
                ? anchor.boundaryMessageId
                : null,
            prefixDigest: typeof anchor.prefixDigest === 'string'
                ? anchor.prefixDigest : '',
            evidenceDigest: typeof anchor.evidenceDigest === 'string'
                ? anchor.evidenceDigest : '',
        },
        ...(typeof record.analysisReceiptRef === 'string'
            ? { analysisReceiptRef: record.analysisReceiptRef } : {}),
        provenance: COMMIT_PROVENANCE.includes(String(record.provenance))
            ? record.provenance as WikiCommitProvenance
            : 'recorded',
        createdAt: record.createdAt,
    }
    const { id: _id, ...identity } = parsed
    if (commitIdentity(identity) !== parsed.id) {
        throw new Error('Wiki commit hash does not match its contents')
    }
    return parsed
}

function parseBranchRecord(value: unknown): WikiBranchRecord | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Invalid wiki branch record')
    }
    const record = value as Partial<WikiBranchRecord>
    if (record.schemaVersion !== WIKI_VCS_SCHEMA_VERSION
        || typeof record.id !== 'string'
        || (record.head !== null && !HASH_PATTERN.test(String(record.head)))
        || typeof record.chatId !== 'string') {
        throw new Error('Invalid wiki branch record')
    }
    return {
        schemaVersion: 1,
        id: record.id,
        characterId: String(record.characterId ?? ''),
        chatId: record.chatId,
        head: record.head ?? null,
        ...(typeof record.parentBranchId === 'string'
            ? { parentBranchId: record.parentBranchId } : {}),
        createdAt: String(record.createdAt ?? ''),
        updatedAt: String(record.updatedAt ?? ''),
    }
}

function parseRefRecord(value: unknown): WikiRefRecord | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Invalid wiki ref record')
    }
    const record = value as Partial<WikiRefRecord>
    if (record.schemaVersion !== WIKI_VCS_SCHEMA_VERSION
        || !REF_KINDS.includes(String(record.kind))
        || typeof record.id !== 'string'
        || !HASH_PATTERN.test(String(record.commitId))
        || typeof record.characterId !== 'string') {
        throw new Error('Invalid wiki ref record')
    }
    return {
        schemaVersion: 1,
        kind: record.kind as WikiRefKind,
        id: record.id,
        commitId: record.commitId as string,
        characterId: record.characterId,
        ...(typeof record.chatId === 'string' ? { chatId: record.chatId } : {}),
        ...(typeof record.chatStateRef === 'string'
            && HASH_PATTERN.test(record.chatStateRef)
            ? { chatStateRef: record.chatStateRef } : {}),
        ...(typeof record.label === 'string' ? { label: record.label } : {}),
        ...(typeof record.reason === 'string'
            ? { reason: record.reason as WikiRecoveryReason } : {}),
        createdAt: String(record.createdAt ?? ''),
    }
}

export function createWikiVcsRepository(
    userDataDirectory: string,
    options: WikiVcsServiceOptions = {}
): WikiVcsService {
    const fileSystem = options.fileSystem ?? nodeFs
    const now = options.now ?? (() => new Date())
    const pathMapCache = new Map<string, Map<string, string>>()
    const workingTreeHashCache = new Map<string, {
        size: number
        mtimeMs: number
        ctimeMs: number
        ino: number
        dev: number
        hash: string
    }>()
    const pendingOperationCache = new Map<string, WikiOperationJournal[]>()

    const invalidatePendingOperationCache = (
        repository: WikiVcsRepository
    ): void => {
        pendingOperationCache.delete(repository.operationsDirectory)
    }

    const cachePathMap = (
        commitId: string,
        paths: Map<string, string>
    ): void => {
        pathMapCache.delete(commitId)
        pathMapCache.set(commitId, paths)
        if (pathMapCache.size > PATH_MAP_CACHE_LIMIT) {
            const oldest = pathMapCache.keys().next().value
            if (oldest !== undefined) pathMapCache.delete(oldest)
        }
    }

    const repositoryFor = (characterId: string, chatId: string) =>
        resolveWikiVcsRepository(userDataDirectory, characterId, chatId)

    const removePendingOperationFromCache = (
        repository: WikiVcsRepository,
        operationId: string
    ): void => {
        const pending = pendingOperationCache.get(repository.operationsDirectory)
        if (!pending) return
        pendingOperationCache.set(
            repository.operationsDirectory,
            pending.filter((journal) => journal.operationId !== operationId)
        )
    }

    const assertNoPendingOperation = async (
        repository: WikiVcsRepository,
        characterId: string,
        chatId: string,
        branchId: string
    ): Promise<void> => {
        let pending = pendingOperationCache.get(repository.operationsDirectory)
        if (!pending) {
            pending = []
            for (const name of await readDirectory(
                fileSystem, repository.operationsDirectory
            )) {
                const journalFile = join(
                    repository.operationsDirectory, name, JOURNAL_FILE
                )
                const raw = await readJson<unknown>(fileSystem, journalFile)
                if (raw === undefined) continue
                const journal = parseJournal(raw)
                if (!journal) {
                    throw new Error(`Wiki operation journal is invalid: ${name}`)
                }
                if (!journal.published) pending.push(journal)
            }
            pendingOperationCache.set(repository.operationsDirectory, pending)
        }
        for (const journal of pending) {
            if (journal.characterId === characterId
                && journal.chatId === chatId
                && journal.branchId === branchId) {
                throw new Error(
                    `Wiki operation pending: recovery required for ${journal.operationId}`
                )
            }
        }
    }

    const writeJournal = async (
        repository: WikiVcsRepository,
        journal: WikiOperationJournal
    ): Promise<void> => {
        try {
            await writeFileAtomically(
                fileSystem,
                join(
                    repository.operationsDirectory,
                    journal.operationId,
                    JOURNAL_FILE
                ),
                `${JSON.stringify(journal, null, 2)}\n`
            )
        }
        catch (error) {
            // An atomic write failure can leave the old or new journal durable.
            invalidatePendingOperationCache(repository)
            throw error
        }
        const pending = pendingOperationCache.get(repository.operationsDirectory)
        if (!pending) return
        const next = pending.filter(
            (existing) => existing.operationId !== journal.operationId
        )
        if (!journal.published) next.push(journal)
        pendingOperationCache.set(repository.operationsDirectory, next)
    }

    const refDirectoryFor = (
        repository: WikiVcsRepository,
        kind: WikiRefKind
    ): string => kind === 'save'
        ? repository.savesDirectory
        : kind === 'autosave'
            ? repository.autosavesDirectory
            : repository.recoveryDirectory

    const ensureFormat = async (repository: WikiVcsRepository): Promise<void> => {
        const existing = await readJson<Record<string, unknown>>(
            fileSystem, repository.formatFile
        )
        if (existing) {
            if (existing.schemaVersion !== WIKI_VCS_SCHEMA_VERSION) {
                throw new Error(
                    'Unsupported wiki VCS schema version: '
                    + String(existing.schemaVersion)
                )
            }
            return
        }
        await writeFileExclusive(fileSystem, repository.formatFile, `${JSON.stringify({
            schemaVersion: WIKI_VCS_SCHEMA_VERSION,
            createdAt: now().toISOString(),
        }, null, 2)}\n`)
    }

    const readCommit = async (
        repository: WikiVcsRepository,
        commitId: string
    ): Promise<WikiCommitRecord | undefined> => {
        const value = await readJson<unknown>(
            fileSystem, commitPath(repository.commitsDirectory, commitId)
        )
        return value === undefined ? undefined : parseCommitRecord(value)
    }

    const requireCommit = async (
        repository: WikiVcsRepository,
        commitId: string
    ): Promise<WikiCommitRecord> => {
        const commit = await readCommit(repository, commitId)
        if (!commit) {
            throw new Error(`Wiki commit is missing or corrupt: ${commitId}`)
        }
        return commit
    }

    const readBranch = async (
        repository: WikiVcsRepository,
        branchId: string
    ): Promise<WikiBranchRecord | undefined> => {
        const value = await readJson<unknown>(
            fileSystem, refPath(repository.branchesDirectory, branchId)
        )
        return parseBranchRecord(value)
    }

    /** A branch plus its chat link; created on first use for older chats. */
    const ensureRepositoryForChat = async (
        characterId: string,
        chatId: string,
        allowPending = false
    ): Promise<{ repository: WikiVcsRepository; branch: WikiBranchRecord }> => {
        const repository = repositoryFor(characterId, chatId)
        await ensureFormat(repository)
        const link = await readJson<WikiChatLink>(fileSystem, repository.linkFile)
        if (link && typeof link.branchId === 'string'
            && link.characterId === characterId
            && link.chatId === chatId) {
            const branch = await readBranch(repository, link.branchId)
            if (!branch
                || branch.characterId !== characterId
                || branch.chatId !== chatId) {
                throw new Error(
                    `Wiki branch is missing or mismatched: ${link.branchId}`
                )
            }
            if (!allowPending) {
                await assertNoPendingOperation(
                    repository, characterId, chatId, branch.id
                )
            }
            return { repository, branch }
        }
        const timestamp = now().toISOString()
        const existingBranch = await readBranch(repository, `branch:${chatId}`)
        if (existingBranch && (existingBranch.characterId !== characterId
            || existingBranch.chatId !== chatId)) {
            throw new Error('Wiki branch ownership does not match')
        }
        const branch: WikiBranchRecord = existingBranch ?? {
            schemaVersion: 1,
            id: `branch:${chatId}`,
            characterId,
            chatId,
            head: null,
            createdAt: timestamp,
            updatedAt: timestamp,
        }
        await writeFileAtomically(
            fileSystem,
            refPath(repository.branchesDirectory, branch.id),
            `${JSON.stringify(branch, null, 2)}\n`
        )
        await writeFileAtomically(fileSystem, repository.linkFile,
            `${JSON.stringify({
                schemaVersion: 1,
                characterId,
                chatId,
                branchId: branch.id,
                materializedCommitId: null,
                materializedRevision: '',
                updatedAt: timestamp,
            } satisfies WikiChatLink, null, 2)}\n`)
        if (!allowPending) {
            await assertNoPendingOperation(
                repository, characterId, chatId, branch.id
            )
        }
        return { repository, branch }
    }

    const writeBranchHead = async (
        repository: WikiVcsRepository,
        branch: WikiBranchRecord,
        head: string | null
    ): Promise<void> => {
        await writeFileAtomically(
            fileSystem,
            refPath(repository.branchesDirectory, branch.id),
            `${JSON.stringify({
                ...branch,
                head,
                updatedAt: now().toISOString(),
            }, null, 2)}\n`
        )
    }

    const writeLinkFor = async (
        repository: WikiVcsRepository,
        branch: WikiBranchRecord,
        commitId: string | null,
        paths: Map<string, string>,
        originChatId?: string
    ): Promise<void> => {
        const existing = await readJson<WikiChatLink>(
            fileSystem, repository.linkFile
        )
        const origin = originChatId ?? existing?.originChatId
        await writeFileAtomically(fileSystem, repository.linkFile,
            `${JSON.stringify({
                schemaVersion: 1,
                characterId: repository.characterId,
                chatId: repository.chatId,
                branchId: branch.id,
                materializedCommitId: commitId,
                materializedRevision: hashBytes(JSON.stringify(
                    [...paths.entries()].sort(
                        ([left], [right]) => left.localeCompare(right)
                    )
                )),
                ...(origin ? { originChatId: origin } : {}),
                updatedAt: now().toISOString(),
            } satisfies WikiChatLink, null, 2)}\n`)
    }

    /**
     * Materialized path map for a commit: walk back to the newest reachable
     * checkpoint, then replay only the deltas written after it.
     */
    const pathMapFor = async (
        repository: WikiVcsRepository,
        commitId: string
    ): Promise<Map<string, string>> => {
        const cached = pathMapCache.get(commitId)
        if (cached) {
            cachePathMap(commitId, cached)
            return cached
        }
        const deltas: WikiCommitRecord[] = []
        const visited = new Set<string>()
        let base: Map<string, string> | undefined
        let cursor: string | null = commitId
        while (cursor) {
            if (visited.has(cursor)) {
                throw new Error('Wiki commit history contains a cycle')
            }
            visited.add(cursor)
            const replayed = pathMapCache.get(cursor)
            if (replayed) {
                base = new Map(replayed)
                break
            }
            const checkpoint = await readJson<WikiCheckpointRecord>(
                fileSystem,
                join(repository.checkpointsDirectory, `${cursor}.json`)
            )
            if (checkpoint) {
                if (checkpoint.schemaVersion !== WIKI_VCS_SCHEMA_VERSION
                    || checkpoint.commitId !== cursor
                    || typeof checkpoint.paths !== 'object'
                    || checkpoint.paths === null) {
                    throw new Error('Invalid wiki checkpoint record')
                }
                const checkpointPaths = new Map<string, string>()
                for (const [rawPath, hash] of Object.entries(checkpoint.paths)) {
                    const path = normalizeWikiVcsPath(rawPath)
                    if (!isWikiVcsTrackedPath(path)
                        || !HASH_PATTERN.test(hash)
                        || checkpointPaths.has(path)) {
                        throw new Error('Invalid wiki checkpoint path map')
                    }
                    checkpointPaths.set(path, hash)
                }
                base = checkpointPaths
                break
            }
            const commit = await requireCommit(repository, cursor)
            deltas.push(commit)
            cursor = commit.parent
        }
        const paths = base ?? new Map<string, string>()
        for (const commit of deltas.reverse()) {
            for (const change of commit.changes) {
                if (change.after === null) paths.delete(change.path)
                else paths.set(change.path, change.after)
            }
        }
        cachePathMap(commitId, paths)
        return paths
    }

    const writeBlob = async (
        repository: WikiVcsRepository,
        contents: string
    ): Promise<string> => {
        const hash = hashBytes(contents)
        const target = blobPath(repository.objectsDirectory, hash)
        if (await pathExists(fileSystem, target)) return hash
        await writeFileAtomically(fileSystem, target, contents)
        return hash
    }

    const readBlob = async (
        repository: WikiVcsRepository,
        hash: string
    ): Promise<string> => {
        const target = blobPath(repository.objectsDirectory, hash)
        const contents = await fileSystem.readFile(target, 'utf8')
        if (hashBytes(contents) !== hash) {
            throw new Error(`Wiki blob checksum verification failed: ${hash}`)
        }
        return contents
    }

    const invalidateWorkingTreePath = (
        repository: WikiVcsRepository,
        path: string
    ): void => {
        workingTreeHashCache.delete(join(
            repository.workingTreeDirectory, ...path.split('/')
        ))
    }

    /** Versioned files currently on disk, keyed by repository path. */
    const readWorkingTree = async (
        repository: WikiVcsRepository
    ): Promise<Map<string, string>> => {
        const paths = new Map<string, string>()
        const root = resolve(repository.workingTreeDirectory)
        const seenFiles = new Set<string>()
        const walk = async (directory: string, prefix: string): Promise<void> => {
            let entries
            try {
                entries = await fileSystem.readdir(directory, { withFileTypes: true })
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
                throw error
            }
            for (const entry of entries) {
                const relativePath = prefix
                    ? `${prefix}/${entry.name}` : entry.name
                const child = join(directory, entry.name)
                if (entry.isDirectory()) {
                    if (entry.name.startsWith('.risubard-')
                        && entry.name !== '.risubard-review') continue
                    await walk(child, relativePath)
                    continue
                }
                if (!entry.isFile() || !isWikiVcsTrackedPath(relativePath)) continue
                const key = join(root, ...relativePath.split('/'))
                seenFiles.add(key)
                const status = await fileSystem.lstat(child)
                const cacheable = Number.isFinite(status.size)
                    && Number.isFinite(status.mtimeMs)
                    && Number.isFinite(status.ctimeMs)
                    && Number.isFinite(status.ino)
                    && Number.isFinite(status.dev)
                const cached = cacheable ? workingTreeHashCache.get(key) : undefined
                if (cached && cached.size === status.size
                    && cached.mtimeMs === status.mtimeMs
                    && cached.ctimeMs === status.ctimeMs
                    && cached.ino === status.ino
                    && cached.dev === status.dev) {
                    paths.set(relativePath, cached.hash)
                    continue
                }
                const hash = hashBytes(await fileSystem.readFile(child, 'utf8'))
                if (cacheable) {
                    workingTreeHashCache.set(key, {
                        size: status.size,
                        mtimeMs: status.mtimeMs,
                        ctimeMs: status.ctimeMs,
                        ino: status.ino,
                        dev: status.dev,
                        hash,
                    })
                }
                else {
                    workingTreeHashCache.delete(key)
                }
                paths.set(relativePath, hash)
            }
        }
        await walk(repository.workingTreeDirectory, '')
        const prefix = `${root}/`
        for (const key of workingTreeHashCache.keys()) {
            if (key.startsWith(prefix) && !seenFiles.has(key)) {
                workingTreeHashCache.delete(key)
            }
        }
        return paths
    }

    const assertSafeMaterializationPath = async (
        repository: WikiVcsRepository,
        path: string
    ): Promise<void> => {
        const root = resolve(userDataDirectory)
        const destination = resolve(
            repository.workingTreeDirectory, normalizeWikiVcsPath(path)
        )
        const localPath = relative(root, destination)
        if (localPath.startsWith('..') || localPath.startsWith('/')) {
            throw new Error('Wiki materialization escaped its data directory')
        }
        const segments = localPath.split('/')
        let current = root
        for (let index = -1; index < segments.length; index += 1) {
            if (index >= 0) current = join(current, segments[index])
            let status: Awaited<ReturnType<RepositoryFileSystem['lstat']>>
            try {
                status = await fileSystem.lstat(current)
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
                throw error
            }
            if (status.isSymbolicLink()) {
                throw new Error(`Wiki materialization path is a symlink: ${path}`)
            }
            const isLeaf = index === segments.length - 1
            if ((!isLeaf && !status.isDirectory())
                || (isLeaf && !status.isFile() && !status.isDirectory())) {
                throw new Error(`Wiki materialization path is unsafe: ${path}`)
            }
        }
    }

    const readWorkingTreePathHash = async (
        repository: WikiVcsRepository,
        path: string
    ): Promise<string | null> => {
        await assertSafeMaterializationPath(repository, path)
        const destination = join(
            repository.workingTreeDirectory, ...path.split('/')
        )
        let status: Awaited<ReturnType<RepositoryFileSystem['lstat']>>
        try {
            status = await fileSystem.lstat(destination)
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            invalidateWorkingTreePath(repository, path)
            return null
        }
        if (!status.isFile()) {
            throw new Error(`Wiki materialization path is unsafe: ${path}`)
        }
        const contents = await fileSystem.readFile(destination, 'utf8')
        invalidateWorkingTreePath(repository, path)
        return hashBytes(contents)
    }

    const createRefRecord = async (input: {
        repository: WikiVcsRepository
        commitId: string
        kind: WikiRefKind
        chatId?: string
        chatStateRef?: string
        reason?: WikiRecoveryReason
        label?: string
        id?: string
    }): Promise<string> => {
        await requireCommit(input.repository, input.commitId)
        const id = input.id ?? `${input.kind}:${randomUUID()}`
        const record: WikiRefRecord = {
            schemaVersion: 1,
            kind: input.kind,
            id,
            commitId: input.commitId,
            characterId: input.repository.characterId,
            ...(input.chatId ? { chatId: input.chatId } : {}),
            ...(input.chatStateRef ? { chatStateRef: input.chatStateRef } : {}),
            ...(input.label ? { label: input.label } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
            createdAt: now().toISOString(),
        }
        await writeFileAtomically(
            fileSystem,
            refPath(refDirectoryFor(input.repository, input.kind), id),
            `${JSON.stringify(record, null, 2)}\n`
        )
        return id
    }

    const writeCheckpointIfDue = async (
        repository: WikiVcsRepository,
        commitId: string
    ): Promise<boolean> => {
        const commit = await requireCommit(repository, commitId)
        const visited = new Set<string>()
        let depth = 0
        let cursor = commit.parent
        while (cursor && depth < CHECKPOINT_INTERVAL) {
            if (visited.has(cursor)) break
            visited.add(cursor)
            if (await pathExists(
                fileSystem,
                join(repository.checkpointsDirectory, `${cursor}.json`)
            )) {
                return false
            }
            cursor = (await requireCommit(repository, cursor)).parent
            depth += 1
        }
        if (depth < CHECKPOINT_INTERVAL) return false
        const paths = await pathMapFor(repository, commitId)
        await writeFileAtomically(
            fileSystem,
            join(repository.checkpointsDirectory, `${commitId}.json`),
            `${JSON.stringify({
                schemaVersion: 1,
                commitId,
                paths: Object.fromEntries([...paths.entries()].sort(
                    ([left], [right]) => left.localeCompare(right)
                )),
                createdAt: now().toISOString(),
            } satisfies WikiCheckpointRecord)}\n`
        )
        return true
    }

    const changedPathsBetweenMaps = (
        current: ReadonlyMap<string, string>,
        next: ReadonlyMap<string, string>
    ): string[] => {
        const changed = new Set<string>()
        for (const [path, hash] of next) {
            if (current.get(path) !== hash) changed.add(path)
        }
        for (const path of current.keys()) {
            if (!next.has(path)) changed.add(path)
        }
        return [...changed].sort()
    }

    const changedPathsBetween = async (
        repository: WikiVcsRepository,
        from: string | null,
        to: string
    ): Promise<string[]> => {
        const current = from
            ? await pathMapFor(repository, from)
            : new Map<string, string>()
        const next = await pathMapFor(repository, to)
        return changedPathsBetweenMaps(current, next)
    }
    const compatibleHistory = async (
        repository: WikiVcsRepository,
        head: string | null,
        prefixes: readonly WikiPrefixCheckpoint[]
    ): Promise<Map<string, {
        compatible: boolean
        ownIndex: number
        effectiveIndex: number
        effectiveAnchor: WikiChatAnchor
    }>> => {
        const commits: WikiCommitRecord[] = []
        const visited = new Set<string>()
        let cursor = head
        while (cursor) {
            if (visited.has(cursor)) {
                throw new Error('Wiki commit history contains a cycle')
            }
            visited.add(cursor)
            const commit = await requireCommit(repository, cursor)
            commits.push(commit)
            cursor = commit.parent
        }
        const messageIds = new Set<string>()
        const prefixDigests = new Set<string>()
        for (const prefix of prefixes) {
            if (!prefix.messageId
                || !PREFIX_DIGEST_PATTERN.test(prefix.prefixDigest)
                || messageIds.has(prefix.messageId)
                || prefixDigests.has(prefix.prefixDigest)) {
                throw new Error('Wiki prefix checkpoints are invalid')
            }
            messageIds.add(prefix.messageId)
            prefixDigests.add(prefix.prefixDigest)
        }
        const positions = new Map<string, number>()
        const digestPositions = new Map<string, number>()
        for (let index = 0; index < prefixes.length; index += 1) {
            const prefix = prefixes[index]
            if (!positions.has(prefix.messageId)) {
                positions.set(prefix.messageId, index)
            }
            if (!digestPositions.has(prefix.prefixDigest)) {
                digestPositions.set(prefix.prefixDigest, index)
            }
        }
        const states = new Map<string, {
            compatible: boolean
            ownIndex: number
            effectiveIndex: number
            effectiveAnchor: WikiChatAnchor
        }>()
        let compatible = true
        let effectiveIndex = -1
        let effectiveAnchor: WikiChatAnchor | undefined
        const emptyPrefixDigest = computeWikiPrefixDigest([])
        for (const commit of commits.reverse()) {
            const anchor = commit.chatAnchor
            const emptyPrefix = anchor.boundaryMessageId === null
                && anchor.prefixDigest === emptyPrefixDigest
            let ownIndex = -1
            if (anchor.prefixDigest) {
                if (anchor.boundaryMessageId === null) {
                    ownIndex = digestPositions.get(anchor.prefixDigest) ?? -1
                }
                else {
                    const boundaryIndex = positions.get(anchor.boundaryMessageId)
                    if (boundaryIndex !== undefined
                        && prefixes[boundaryIndex].prefixDigest
                            === anchor.prefixDigest) {
                        ownIndex = boundaryIndex
                    }
                }
            }
            if (ownIndex === -1 && !emptyPrefix) {
                compatible = false
            }
            if (ownIndex >= effectiveIndex) {
                effectiveIndex = ownIndex
                effectiveAnchor = ownIndex >= 0 && anchor.boundaryMessageId === null
                    ? { ...anchor, boundaryMessageId: prefixes[ownIndex].messageId } : anchor
            }
            states.set(commit.id, {
                compatible,
                ownIndex,
                effectiveIndex,
                effectiveAnchor: effectiveAnchor ?? anchor,
            })
        }
        return states
    }
    const completeMaterialization = async (
        repository: WikiVcsRepository,
        branch: WikiBranchRecord,
        journal: WikiOperationJournal
    ): Promise<void> => {
        const beforePaths = journal.beforePaths
        const targetPaths = journal.targetPaths
        if (!beforePaths || !targetPaths) {
            throw new Error(`Wiki materialization journal is incomplete: ${journal.operationId}`)
        }
        for (const path of journal.changedPaths) {
            if (!Object.hasOwn(beforePaths, path)
                || !Object.hasOwn(targetPaths, path)) {
                throw new Error(`Wiki materialization journal is incomplete: ${path}`)
            }
        }
        const commitPaths = await pathMapFor(repository, journal.commitId)
        for (const path of journal.changedPaths) {
            if ((commitPaths.get(path) ?? null) !== targetPaths[path]) {
                throw new Error(`Wiki materialization target is inconsistent: ${path}`)
            }
        }
        for (const path of journal.changedPaths) {
            const currentHash = await readWorkingTreePathHash(repository, path)
            const expectedHash = beforePaths[path]
            const desiredHash = targetPaths[path]
            if (currentHash !== desiredHash && currentHash !== expectedHash) {
                throw new WikiMaterializationConflictError(
                    journal.operationId, path, currentHash,
                    expectedHash, desiredHash
                )
            }
            if (currentHash === desiredHash) continue

            const destination = join(
                repository.workingTreeDirectory, ...path.split('/')
            )
            const contents = desiredHash === null
                ? null : await readBlob(repository, desiredHash)
            const latestHash = await readWorkingTreePathHash(repository, path)
            if (latestHash === desiredHash) continue
            if (latestHash !== expectedHash) {
                throw new WikiMaterializationConflictError(
                    journal.operationId, path, latestHash,
                    expectedHash, desiredHash
                )
            }
            try {
                if (desiredHash === null) {
                    await removeFileDurably(fileSystem, destination)
                }
                else {
                    await writeFileAtomically(fileSystem, destination, contents!)
                }
            }
            finally {
                invalidateWorkingTreePath(repository, path)
            }
        }
        const materializedPaths = await readWorkingTree(repository)
        for (const path of journal.changedPaths) {
            const desiredHash = targetPaths[path]
            const currentHash = await readWorkingTreePathHash(repository, path)
            if (currentHash !== desiredHash) {
                throw new WikiMaterializationConflictError(
                    journal.operationId, path, currentHash,
                    beforePaths[path], desiredHash
                )
            }
            if (currentHash === null) materializedPaths.delete(path)
            else materializedPaths.set(path, currentHash)
        }
        if (journal.recoveryRefId && journal.previousHead
            && journal.previousHead !== journal.commitId) {
            const directory = refDirectoryFor(repository, 'recovery')
            const existing = parseRefRecord(await readJson<unknown>(
                fileSystem, refPath(directory, journal.recoveryRefId)
            ))
            if (existing) {
                if (existing.commitId !== journal.previousHead
                    || existing.chatId !== journal.chatId) {
                    throw new Error('Wiki recovery ref does not match its journal')
                }
            }
            else {
                await createRefRecord({
                    repository,
                    commitId: journal.previousHead,
                    kind: 'recovery',
                    chatId: journal.chatId,
                    reason: journal.reason ?? 'truncate',
                    id: journal.recoveryRefId,
                })
            }
        }
        await writeBranchHead(repository, branch, journal.commitId)
        await writeLinkFor(
            repository, branch, journal.commitId, materializedPaths
        )
        if (journal.mode === 'publish') {
            const receipt: WikiOperationReceipt = {
                schemaVersion: 1,
                operationId: journal.operationId,
                status: 'completed',
                branchId: journal.branchId,
                chatId: journal.chatId,
                characterId: journal.characterId,
                commitId: journal.commitId,
                previousHead: journal.previousHead,
                changedPaths: journal.changedPaths,
                checkpointCreated: journal.checkpointCreated,
                createdAt: journal.createdAt,
            }
            await writeFileAtomically(
                fileSystem,
                join(
                    repository.operationsDirectory,
                    journal.operationId,
                    'receipt.json'
                ),
                `${JSON.stringify(receipt, null, 2)}\n`
            )
        }
        await writeJournal(repository, { ...journal, published: true })
    }

    const service: WikiVcsService = {
        async ensureRepository(characterId: string, chatId: string) {
            const { branch } = await ensureRepositoryForChat(characterId, chatId)
            return { branchId: branch.id, head: branch.head }
        },

        async readLink(characterId: string, chatId: string) {
            const repository = repositoryFor(characterId, chatId)
            const link = await readJson<WikiChatLink>(
                fileSystem, repository.linkFile
            )
            await assertNoPendingOperation(
                repository,
                characterId,
                chatId,
                link?.branchId ?? `branch:${chatId}`
            )
            return link
        },

        async readCommit(characterId: string, chatId: string, commitId: string) {
            const { repository } = await ensureRepositoryForChat(characterId, chatId)
            return readCommit(repository, commitId)
        },

        async readPathMap(
            characterId: string,
            chatId: string,
            commitId: string
        ): Promise<Record<string, string>> {
            const { repository } = await ensureRepositoryForChat(characterId, chatId)
            return Object.fromEntries([...(await pathMapFor(repository, commitId))])
        },

        async discardChatBranch(
            characterId: string,
            chatId: string
        ): Promise<void> {
            const repository = repositoryFor(characterId, chatId)
            const link = await readJson<WikiChatLink>(
                fileSystem, repository.linkFile
            )
            await assertNoPendingOperation(
                repository,
                characterId,
                chatId,
                link?.branchId ?? `branch:${chatId}`
            )
            if (link?.characterId !== characterId || link.chatId !== chatId) {
                await removeFileDurably(fileSystem, repository.linkFile)
                return
            }
            const branch = await readBranch(repository, link.branchId)
            if (branch?.characterId !== characterId || branch.chatId !== chatId) {
                throw new Error('Wiki branch ownership does not match')
            }
            await removeFileDurably(
                fileSystem,
                refPath(repository.branchesDirectory, link.branchId)
            )
            await removeFileDurably(fileSystem, repository.linkFile)
        },


        async discardUnpublishedOperation(input: {
            characterId: string
            chatId: string
            operationId: string
        }): Promise<void> {
            const { repository, branch } = await ensureRepositoryForChat(
                input.characterId, input.chatId
            )
            const directory = join(
                repository.operationsDirectory, operationIdentifier(input.operationId)
            )
            const journal = parseJournal(await readJson<unknown>(
                fileSystem, join(directory, JOURNAL_FILE)
            ))
            if (journal?.commitId === branch.head) {
                throw new Error('Cannot discard a published Wiki operation')
            }
            try {
                await fileSystem.rm(directory, { recursive: true, force: true })
            }
            catch (error) {
                invalidatePendingOperationCache(repository)
                throw error
            }
            removePendingOperationFromCache(repository, input.operationId)
        },

        async listDeletedRecovery(characterId: string): Promise<WikiRefRecord[]> {
            const repository = repositoryFor(characterId, `refs:${characterId}`)
            const directory = refDirectoryFor(repository, 'recovery')
            const records: WikiRefRecord[] = []
            for (const name of await readDirectory(fileSystem, directory)) {
                if (!name.endsWith('.json')) continue
                const record = parseRefRecord(await readJson<unknown>(
                    fileSystem, join(directory, name)
                ))
                if (record?.reason === 'chat-delete') records.push(record)
            }
            return records
        },

        /**
         * Publishes one logical operation as one commit. Re-issuing the same
         * operation ID returns the recorded receipt instead of a second commit.
         */
        async commit(input: WikiCommitRequest): Promise<WikiOperationReceipt> {
            const characterId = requiredString(input.characterId, 'Character ID')
            const chatId = requiredString(input.chatId, 'Chat ID')
            const operationId = operationIdentifier(input.operationId)
            const { repository, branch } = await ensureRepositoryForChat(
                characterId, chatId
            )
            const receiptFile = join(
                repository.operationsDirectory, operationId, 'receipt.json'
            )
            const existing = await readJson<WikiOperationReceipt>(
                fileSystem, receiptFile
            )
            if (existing) return existing
            if (input.expectedHead !== undefined
                && input.expectedHead !== branch.head) {
                throw new Error(
                    'Wiki commit conflict: the branch head changed'
                )
            }
            if (input.changes.length === 0) {
                throw new Error('Wiki commit must contain at least one change')
            }
            const base = branch.head
                ? await pathMapFor(repository, branch.head)
                : new Map<string, string>()
            const seen = new Set<string>()
            const resolved: WikiCommitRecord['changes'] = []
            for (const change of input.changes) {
                const path = normalizeWikiVcsPath(change.path)
                if (!isWikiVcsTrackedPath(path)) {
                    throw new Error(`Path is not versioned by BardWiki: ${path}`)
                }
                if (seen.has(path)) {
                    throw new Error(`Duplicate wiki commit path: ${path}`)
                }
                seen.add(path)
                const before = base.get(path) ?? null
                const after = change.contents === null
                    ? null
                    : await writeBlob(repository, change.contents)
                if (before !== after) resolved.push({ path, before, after })
            }
            if (resolved.length === 0) {
                throw new Error('Wiki commit has no effective change')
            }
            resolved.sort((left, right) => left.path.localeCompare(right.path))
            const payload: Omit<WikiCommitRecord, 'id'> = {
                schemaVersion: 1,
                parent: branch.head,
                operationId,
                kind: input.kind,
                changes: resolved,
                chatAnchor: input.chatAnchor,
                ...(input.analysisReceiptRef
                    ? { analysisReceiptRef: input.analysisReceiptRef } : {}),
                provenance: input.provenance ?? 'recorded',
                createdAt: now().toISOString(),
            }
            const commitId = commitIdentity(payload)
            const operationDirectory = join(
                repository.operationsDirectory, operationId
            )
            // Journal first: everything after this point is replayable, so a
            // crash between the commit record and the branch head leaves a
            // recoverable state instead of a silent half-publish.
            const journal: WikiOperationJournal = {
                schemaVersion: 1,
                operationId,
                characterId,
                chatId,
                branchId: branch.id,
                previousHead: branch.head,
                commitId,
                changedPaths: resolved.map((change) => change.path),
                checkpointCreated: false,
                prepared: false,
                published: false,
                createdAt: now().toISOString(),
            }
            await writeJournal(repository, journal)
            await writeFileAtomically(
                fileSystem,
                commitPath(repository.commitsDirectory, commitId),
                `${JSON.stringify({ ...payload, id: commitId }, null, 2)}\n`
            )
            const nextPaths = new Map(base)
            for (const change of resolved) {
                if (change.after === null) nextPaths.delete(change.path)
                else nextPaths.set(change.path, change.after)
            }
            cachePathMap(commitId, nextPaths)
            const checkpointCreated = await writeCheckpointIfDue(
                repository, commitId
            )
            await writeJournal(repository, {
                ...journal,
                checkpointCreated,
                prepared: true,
            })
            await writeBranchHead(repository, branch, commitId)
            const receipt: WikiOperationReceipt = {
                schemaVersion: 1,
                operationId,
                status: 'completed',
                branchId: branch.id,
                chatId,
                characterId,
                commitId,
                previousHead: branch.head,
                changedPaths: resolved.map((change) => change.path),
                checkpointCreated,
                createdAt: now().toISOString(),
            }
            await writeFileAtomically(
                fileSystem, receiptFile, `${JSON.stringify(receipt, null, 2)}\n`
            )
            await writeJournal(repository, {
                ...journal,
                checkpointCreated,
                prepared: true,
                published: true,
            })
            return receipt
        },
        /** Publishes sparse staged changes and materializes them atomically. */
        async publishChanges(
            input: WikiPublishChangesRequest
        ): Promise<WikiPublishChangesResult> {
            const characterId = requiredString(input.characterId, 'Character ID')
            const chatId = requiredString(input.chatId, 'Chat ID')
            const operationId = operationIdentifier(input.operationId)
            let { repository, branch } = await ensureRepositoryForChat(
                characterId, chatId
            )
            const operationDirectory = join(
                repository.operationsDirectory, operationId
            )
            const receiptFile = join(operationDirectory, 'receipt.json')
            const previousReceipt = await readJson<WikiOperationReceipt>(
                fileSystem, receiptFile
            )
            if (previousReceipt?.status === 'completed') {
                const existingJournal = parseJournal(await readJson<unknown>(
                    fileSystem, join(operationDirectory, JOURNAL_FILE)
                ))
                if (existingJournal?.mode !== 'publish'
                    || !existingJournal.published) {
                    throw new Error('Wiki operation ID was used by another operation')
                }
                return {
                    commitId: previousReceipt.commitId,
                    changedPaths: [...previousReceipt.changedPaths],
                }
            }

            let actual = await readWorkingTree(repository)
            let base = branch.head
                ? await pathMapFor(repository, branch.head)
                : new Map<string, string>()
            if (changedPathsBetweenMaps(base, actual).length > 0) {
                const externalAnchor = input.chatAnchor
                    ?? (branch.head
                        ? (await requireCommit(repository, branch.head)).chatAnchor
                        : {
                            sourceChatId: chatId,
                            boundaryMessageId: null,
                            prefixDigest: '',
                            evidenceDigest: '',
                        })
                await service.captureExternalChanges({
                    characterId,
                    chatId,
                    chatAnchor: externalAnchor,
                    operationId: `external:${randomUUID()}`,
                    kind: 'external',
                })
                const refreshed = await ensureRepositoryForChat(
                    characterId, chatId
                )
                repository = refreshed.repository
                branch = refreshed.branch
                actual = await readWorkingTree(repository)
                base = branch.head
                    ? await pathMapFor(repository, branch.head)
                    : new Map<string, string>()
            }
            if (input.expectedHead !== branch.head) {
                throw new Error('Wiki commit conflict: the branch head changed')
            }
            const seen = new Set<string>()
            const resolved: WikiCommitRecord['changes'] = []
            for (const change of input.changes) {
                const path = normalizeWikiVcsPath(change.path)
                if (!isWikiVcsTrackedPath(path)) {
                    throw new Error(`Path is not versioned by BardWiki: ${path}`)
                }
                if (seen.has(path)) {
                    throw new Error(`Duplicate wiki commit path: ${path}`)
                }
                seen.add(path)
                const before = base.get(path) ?? null
                const after = change.contents === null
                    ? null
                    : await writeBlob(repository, change.contents)
                if (before !== after) resolved.push({ path, before, after })
            }
            if (resolved.length === 0) {
                return { commitId: null, changedPaths: [] }
            }
            resolved.sort((left, right) => left.path.localeCompare(right.path))
            const commitAnchor = input.chatAnchor
                ?? (branch.head
                    ? (await requireCommit(repository, branch.head)).chatAnchor
                    : {
                        sourceChatId: chatId,
                        boundaryMessageId: null,
                        prefixDigest: '',
                        evidenceDigest: '',
                    })
            const payload: Omit<WikiCommitRecord, 'id'> = {
                schemaVersion: 1,
                parent: branch.head,
                operationId,
                kind: input.kind,
                changes: resolved,
                chatAnchor: commitAnchor,
                provenance: 'recorded',
                createdAt: now().toISOString(),
            }
            const commitId = commitIdentity(payload)
            const changedPaths = resolved.map((change) => change.path)
            const journal: WikiOperationJournal = {
                schemaVersion: 1,
                operationId,
                characterId,
                chatId,
                branchId: branch.id,
                previousHead: branch.head,
                commitId,
                mode: 'publish',
                changedPaths,
                beforePaths: Object.fromEntries(changedPaths.map((path) => [
                    path, actual.get(path) ?? null,
                ])),
                targetPaths: Object.fromEntries(resolved.map((change) => [
                    change.path, change.after,
                ])),
                checkpointCreated: false,
                prepared: false,
                published: false,
                createdAt: now().toISOString(),
            }
            await writeJournal(repository, journal)
            await writeFileAtomically(
                fileSystem,
                commitPath(repository.commitsDirectory, commitId),
                `${JSON.stringify({ ...payload, id: commitId }, null, 2)}\n`
            )
            const nextPaths = new Map(base)
            for (const change of resolved) {
                if (change.after === null) nextPaths.delete(change.path)
                else nextPaths.set(change.path, change.after)
            }
            cachePathMap(commitId, nextPaths)
            const checkpointCreated = await writeCheckpointIfDue(
                repository, commitId
            )
            const preparedJournal = {
                ...journal,
                checkpointCreated,
                prepared: true,
            }
            await writeJournal(repository, preparedJournal)
            await completeMaterialization(repository, branch, preparedJournal)
            return { commitId, changedPaths }
        },


        /**
         * Records on-disk edits as exactly one commit and never discards them.
         * A caller that just performed a wiki write passes its own kind so the
         * commit says what the operation was, not merely that files differ.
         */
        async captureExternalChanges(input: {
            characterId: string
            chatId: string
            chatAnchor: WikiChatAnchor
            operationId?: string
            kind?: WikiCommitKind
            analysisReceiptRef?: string
            provenance?: WikiCommitProvenance
            expectedHead?: string | null
        }): Promise<{ commitId: string | null; changedPaths: string[] }> {
            const { repository, branch } = await ensureRepositoryForChat(
                input.characterId, input.chatId
            )
            const operationId = operationIdentifier(
                input.operationId ?? `external:${randomUUID()}`
            )
            const operationDirectory = join(
                repository.operationsDirectory, operationId
            )
            const receiptFile = join(operationDirectory, 'receipt.json')
            const existingReceipt = await readJson<WikiOperationReceipt>(
                fileSystem, receiptFile
            )
            if (existingReceipt?.status === 'completed') {
                return {
                    commitId: existingReceipt.commitId,
                    changedPaths: [...existingReceipt.changedPaths],
                }
            }
            if (input.expectedHead !== undefined
                && input.expectedHead !== branch.head) {
                throw new Error('Wiki commit conflict: the branch head changed')
            }
            const workingTree = await readWorkingTree(repository)
            const head = branch.head
                ? await pathMapFor(repository, branch.head)
                : new Map<string, string>()
            const changes: WikiCommitRecord['changes'] = []
            for (const [path, hash] of workingTree) {
                if (head.get(path) === hash) continue
                const written = await writeBlob(
                    repository,
                    await fileSystem.readFile(
                        join(repository.workingTreeDirectory, ...path.split('/')),
                        'utf8'
                    )
                )
                if (written !== hash) {
                    throw new Error(`Wiki blob verification failed: ${path}`)
                }
                changes.push({ path, before: head.get(path) ?? null, after: hash })
            }
            for (const [path, hash] of head) {
                if (!workingTree.has(path)) {
                    changes.push({ path, before: hash, after: null })
                }
            }
            if (changes.length === 0) {
                return { commitId: null, changedPaths: [] }
            }
            changes.sort((left, right) => left.path.localeCompare(right.path))
            const payload: Omit<WikiCommitRecord, 'id'> = {
                schemaVersion: 1,
                parent: branch.head,
                operationId,
                kind: input.kind ?? 'external',
                changes,
                chatAnchor: input.chatAnchor,
                ...(input.analysisReceiptRef
                    ? { analysisReceiptRef: input.analysisReceiptRef } : {}),
                provenance: input.provenance ?? 'recorded',
                createdAt: now().toISOString(),
            }
            const commitId = commitIdentity(payload)
            const journal: WikiOperationJournal = {
                schemaVersion: 1,
                operationId,
                characterId: input.characterId,
                chatId: input.chatId,
                branchId: branch.id,
                previousHead: branch.head,
                commitId,
                changedPaths: changes.map((change) => change.path),
                checkpointCreated: false,
                prepared: false,
                published: false,
                createdAt: now().toISOString(),
            }
            await writeJournal(repository, journal)
            await writeFileAtomically(
                fileSystem,
                commitPath(repository.commitsDirectory, commitId),
                `${JSON.stringify({ ...payload, id: commitId }, null, 2)}\n`
            )
            const nextPaths = new Map(head)
            for (const change of changes) {
                if (change.after === null) nextPaths.delete(change.path)
                else nextPaths.set(change.path, change.after)
            }
            cachePathMap(commitId, nextPaths)
            const checkpointCreated = await writeCheckpointIfDue(
                repository, commitId
            )
            await writeJournal(repository, {
                ...journal,
                checkpointCreated,
                prepared: true,
            })
            await writeBranchHead(repository, branch, commitId)
            const receipt: WikiOperationReceipt = {
                schemaVersion: 1,
                operationId,
                status: 'completed',
                branchId: branch.id,
                chatId: input.chatId,
                characterId: input.characterId,
                commitId,
                previousHead: branch.head,
                changedPaths: changes.map((change) => change.path),
                checkpointCreated,
                createdAt: now().toISOString(),
            }
            await writeFileAtomically(
                fileSystem,
                receiptFile,
                `${JSON.stringify(receipt, null, 2)}\n`
            )
            await writeJournal(repository, {
                ...journal,
                checkpointCreated,
                prepared: true,
                published: true,
            })
            return {
                commitId,
                changedPaths: changes.map((change) => change.path),
            }
        },

        /**
         * Creates a legacy baseline from the current working tree without
         * modifying it. Re-entry after an interrupt is a no-op.
         */
        async ensureBaseline(input: {
            characterId: string
            chatId: string
            chatAnchor: WikiChatAnchor
            operationId?: string
        }): Promise<{ created: boolean; commitId: string | null; branchId: string }> {
            const characterId = requiredString(input.characterId, 'Character ID')
            const chatId = requiredString(input.chatId, 'Chat ID')
            const { repository, branch } = await ensureRepositoryForChat(
                characterId, chatId
            )
            if (branch.head) {
                return { created: false, commitId: branch.head, branchId: branch.id }
            }
            const workingTree = await readWorkingTree(repository)
            const changes: WikiCommitRecord['changes'] = []
            for (const [path, hash] of [...workingTree.entries()].sort(
                ([left], [right]) => left.localeCompare(right)
            )) {
                const written = await writeBlob(
                    repository,
                    await fileSystem.readFile(
                        join(repository.workingTreeDirectory, ...path.split('/')),
                        'utf8'
                    )
                )
                if (written !== hash) {
                    throw new Error(`Wiki blob verification failed: ${path}`)
                }
                changes.push({ path, before: null, after: hash })
            }
            const operationId = operationIdentifier(
                input.operationId ?? `baseline:${randomUUID()}`
            )
            const payload: Omit<WikiCommitRecord, 'id'> = {
                schemaVersion: 1,
                parent: null,
                operationId,
                kind: 'baseline',
                changes,
                chatAnchor: input.chatAnchor,
                provenance: 'legacy-baseline',
                createdAt: now().toISOString(),
            }
            const commitId = commitIdentity(payload)
            const journal: WikiOperationJournal = {
                schemaVersion: 1,
                operationId,
                characterId,
                chatId,
                branchId: branch.id,
                previousHead: null,
                commitId,
                mode: 'baseline',
                changedPaths: changes.map((change) => change.path),
                checkpointCreated: false,
                prepared: false,
                published: false,
                createdAt: now().toISOString(),
            }
            await writeJournal(repository, journal)
            await writeFileAtomically(
                fileSystem,
                commitPath(repository.commitsDirectory, commitId),
                `${JSON.stringify({ ...payload, id: commitId }, null, 2)}\n`
            )
            const paths = new Map(changes.map((change) => [
                change.path, change.after as string,
            ]))
            cachePathMap(commitId, paths)
            const preparedJournal = { ...journal, prepared: true }
            await writeJournal(repository, preparedJournal)
            await writeBranchHead(repository, branch, commitId)
            await writeLinkFor(repository, branch, commitId, paths)
            await writeJournal(repository, { ...preparedJournal, published: true })
            return { created: true, commitId, branchId: branch.id }
        },

        async listHistory(input: {
            characterId: string
            chatId: string
            limit?: number
        }): Promise<WikiHistoryEntry[]> {
            const { repository, branch } = await ensureRepositoryForChat(
                input.characterId, input.chatId
            )
            const limit = input.limit ?? 200
            const entries: WikiHistoryEntry[] = []
            const visited = new Set<string>()
            let cursor = branch.head
            while (cursor && entries.length < limit) {
                if (visited.has(cursor)) {
                    throw new Error('Wiki commit history contains a cycle')
                }
                visited.add(cursor)
                const commit = await requireCommit(repository, cursor)
                entries.push({
                    commitId: commit.id,
                    parent: commit.parent,
                    kind: commit.kind,
                    provenance: commit.provenance,
                    createdAt: commit.createdAt,
                    boundaryMessageId: commit.chatAnchor.boundaryMessageId,
                    sourceChatId: commit.chatAnchor.sourceChatId,
                    changedPaths: commit.changes.map((change) => change.path),
                    exact: true,
                    onActiveBranch: true,
                })
                cursor = commit.parent
            }
            return entries
        },

        async previewCheckout(input: {
            characterId: string
            chatId: string
            commitId: string
            messages?: readonly WikiAnchorMessage[]
            prefixes?: readonly WikiPrefixCheckpoint[]
        }): Promise<WikiCheckoutPreview> {
            const { repository, branch } = await ensureRepositoryForChat(
                input.characterId, input.chatId
            )
            const target = await requireCommit(repository, input.commitId)
            const digests = input.messages
                ? computeWikiPrefixDigests(input.messages)
                : undefined
            const prefixes = input.prefixes ?? input.messages?.map((message, index) => ({
                messageId: message.messageId,
                prefixDigest: digests![index],
            }))
            const compatibility = prefixes
                ? (await compatibleHistory(repository, target.id, prefixes))
                    .get(target.id)
                : undefined
            return {
                commitId: target.id,
                branchId: branch.id,
                exact: compatibility?.compatible ?? true,
                chatAnchor: compatibility?.effectiveAnchor ?? target.chatAnchor,
                changedPaths: await changedPathsBetween(
                    repository, branch.head, target.id
                ),
                targetExists: await pathExists(
                    fileSystem, repository.workingTreeDirectory
                ),
            }
        },

        /**
         * Moves the branch head and materializes only the differing paths.
         * The previous head is preserved as a recovery ref, so a truncation
         * never destroys the future it replaced.
         */
        async checkout(input: {
            characterId: string
            chatId: string
            commitId: string
            reason?: WikiRecoveryReason
            chatAnchor?: WikiChatAnchor
        }): Promise<{
            branchId: string
            commitId: string
            previousHead: string | null
            changedPaths: string[]
            recoveryRefId: string | null
        }> {
            const characterId = requiredString(input.characterId, 'Character ID')
            const chatId = requiredString(input.chatId, 'Chat ID')
            const { repository, branch } = await ensureRepositoryForChat(
                characterId, chatId
            )
            const actual = await readWorkingTree(repository)
            const target = await requireCommit(repository, input.commitId)
            const next = await pathMapFor(repository, target.id)
            const changedPaths = changedPathsBetweenMaps(actual, next)
            for (const path of changedPaths) {
                await assertSafeMaterializationPath(repository, path)
                const hash = next.get(path)
                if (hash) await readBlob(repository, hash)
            }
            const operationId = `checkout:${randomUUID()}`
            const previousHead = branch.head
            const recoveryRefId = previousHead && previousHead !== target.id
                ? `recovery:${hashBytes(operationId)}`
                : null
            const journal: WikiOperationJournal = {
                schemaVersion: 1,
                operationId,
                characterId,
                chatId,
                branchId: branch.id,
                previousHead,
                commitId: target.id,
                mode: 'checkout',
                changedPaths,
                beforePaths: Object.fromEntries(changedPaths.map((path) => [
                    path, actual.get(path) ?? null,
                ])),
                targetPaths: Object.fromEntries(changedPaths.map((path) => [
                    path, next.get(path) ?? null,
                ])),
                ...(recoveryRefId ? { recoveryRefId } : {}),
                ...(input.reason ? { reason: input.reason } : {}),
                checkpointCreated: false,
                prepared: true,
                published: false,
                createdAt: now().toISOString(),
            }
            await writeJournal(repository, journal)
            await completeMaterialization(repository, branch, journal)
            return {
                branchId: branch.id,
                commitId: target.id,
                previousHead,
                changedPaths,
                recoveryRefId,
            }
        },

        async createRef(input: {
            characterId: string
            chatId?: string
            chatStateRef?: string
            commitId: string
            kind: WikiRefKind
            reason?: WikiRecoveryReason
            label?: string
            id?: string
        }): Promise<string> {
            const characterId = requiredString(input.characterId, 'Character ID')
            const { repository } = await ensureRepositoryForChat(
                characterId, input.chatId ?? `refs:${characterId}`
            )
            return createRefRecord({
                repository,
                commitId: input.commitId,
                kind: input.kind,
                ...(input.chatId ? { chatId: input.chatId } : {}),
                ...(input.chatStateRef ? { chatStateRef: input.chatStateRef } : {}),
                ...(input.reason ? { reason: input.reason } : {}),
                ...(input.label ? { label: input.label } : {}),
                ...(input.id ? { id: input.id } : {}),
            })
        },

        async listRefs(input: {
            characterId: string
            chatId: string
            kind: WikiRefKind
        }): Promise<WikiRefRecord[]> {
            const { repository } = await ensureRepositoryForChat(
                input.characterId, input.chatId
            )
            const directory = refDirectoryFor(repository, input.kind)
            const records: WikiRefRecord[] = []
            for (const name of (await readDirectory(fileSystem, directory)).sort()) {
                if (!name.endsWith('.json')) continue
                const record = parseRefRecord(await readJson<unknown>(
                    fileSystem, join(directory, name)
                ))
                if (record?.chatId === input.chatId) records.push(record)
            }
            return records
        },

        async deleteRef(input: {
            characterId: string
            chatId: string
            kind: WikiRefKind
            id: string
        }): Promise<void> {
            const { repository } = await ensureRepositoryForChat(
                input.characterId, input.chatId
            )
            const file = refPath(
                refDirectoryFor(repository, input.kind), input.id
            )
            const record = parseRefRecord(await readJson<unknown>(
                fileSystem, file
            ))
            if (!record) return
            if (record.chatId !== input.chatId) {
                throw new Error('Wiki ref belongs to another chat')
            }
            await fileSystem.rm(file, { force: true })
        },

        /** New chat that shares this repository and starts from the commit. */
        async fork(input: {
            characterId: string
            sourceChatId: string
            destinationChatId: string
            commitId: string
        }): Promise<{ branchId: string; commitId: string; changedPaths: string[] }> {
            const characterId = requiredString(input.characterId, 'Character ID')
            const sourceChatId = requiredString(input.sourceChatId, 'Source chat ID')
            const destinationChatId = requiredString(
                input.destinationChatId, 'Destination chat ID'
            )
            if (sourceChatId === destinationChatId) {
                throw new Error('Wiki fork source and destination must differ')
            }
            const source = repositoryFor(characterId, sourceChatId)
            await ensureFormat(source)
            const target = await requireCommit(source, input.commitId)
            const paths = await pathMapFor(source, target.id)
            const destination = repositoryFor(characterId, destinationChatId)
            if (await pathExists(fileSystem, destination.linkFile)) {
                const existingLink = await readJson<WikiChatLink>(
                    fileSystem, destination.linkFile
                )
                if (existingLink?.characterId === characterId
                    && existingLink.chatId === destinationChatId) {
                    throw new Error('Wiki fork destination already exists')
                }
                await fileSystem.rm(destination.linkFile, { force: true })
            }
            const timestamp = now().toISOString()
            const branch: WikiBranchRecord = {
                schemaVersion: 1,
                id: `branch:${destinationChatId}`,
                characterId,
                chatId: destinationChatId,
                head: target.id,
                parentBranchId: `branch:${sourceChatId}`,
                createdAt: timestamp,
                updatedAt: timestamp,
            }
            for (const path of paths.keys()) {
                await assertSafeMaterializationPath(destination, path)
            }
            const changedPaths: string[] = []
            for (const [path, hash] of paths) {
                const destinationPath = join(
                    destination.workingTreeDirectory, ...path.split('/')
                )
                try {
                    await writeFileAtomically(
                        fileSystem,
                        destinationPath,
                        await readBlob(source, hash)
                    )
                }
                finally {
                    invalidateWorkingTreePath(destination, path)
                }
                changedPaths.push(path)
            }
            await writeBranchHead(destination, branch, target.id)
            await writeLinkFor(
                destination, branch, target.id, paths, sourceChatId
            )
            return {
                branchId: branch.id,
                commitId: target.id,
                changedPaths: changedPaths.sort(),
            }
        },
        async findCommitForPrefixes(input: {
            characterId: string
            chatId: string
            prefixes: readonly WikiPrefixCheckpoint[]
            minimumBoundaryMessageId?: string | null
        }): Promise<string | null> {
            const { repository, branch } = await ensureRepositoryForChat(
                input.characterId, input.chatId
            )
            const minimumIndex = input.minimumBoundaryMessageId
                ? input.prefixes.findIndex((prefix) =>
                    prefix.messageId === input.minimumBoundaryMessageId)
                : -1
            if (input.minimumBoundaryMessageId && minimumIndex < 0) return null
            const states = await compatibleHistory(
                repository, branch.head, input.prefixes
            )
            let cursor = branch.head
            while (cursor) {
                const commit = await requireCommit(repository, cursor)
                const state = states.get(cursor)
                if (state?.compatible
                    && state.effectiveIndex >= minimumIndex) {
                    return cursor
                }
                cursor = commit.parent
            }
            return null
        },



        /**
         * Chat recovery bytes live beside the wiki objects and are keyed by
         * content hash, so an unchanged chat costs no extra storage.
         */
        async storeChatState(input: {
            characterId: string
            chatId: string
            contents: string
        }): Promise<string> {
            const { repository } = await ensureRepositoryForChat(
                input.characterId, input.chatId
            )
            const storeObject = async (contents: string): Promise<string> => {
                const hash = hashBytes(contents)
                const target = join(
                    repository.directory, AUTOSAVE_STATE_DIRECTORY, hash
                )
                if (!await pathExists(fileSystem, target)) {
                    await writeFileAtomically(fileSystem, target, contents)
                }
                return hash
            }
            let decoded: unknown
            try {
                decoded = chatUnpacker.unpack(Buffer.from(input.contents, 'base64'))
            }
            catch {
                // Existing callers may store opaque recovery bytes.
                return storeObject(input.contents)
            }
            if (typeof decoded !== 'object' || decoded === null
                || !('message' in decoded) || !Array.isArray(decoded.message)) {
                return storeObject(input.contents)
            }
            const { message, ...header } = decoded
            const headerHash = await storeObject(
                chatPacker.pack(header).toString('base64')
            )
            const messages: string[] = []
            for (const item of message) {
                messages.push(await storeObject(
                    chatPacker.pack(item).toString('base64')
                ))
            }
            return storeObject(JSON.stringify({
                schemaVersion: 2, header: headerHash, messages,
            }))
        },

        async readChatState(input: {
            characterId: string
            chatId: string
            hash: string
        }): Promise<string | null> {
            const { repository } = await ensureRepositoryForChat(
                input.characterId, input.chatId
            )
            if (!HASH_PATTERN.test(input.hash)) {
                throw new Error('Invalid chat state hash')
            }
            try {
                const contents = await fileSystem.readFile(
                    join(repository.directory, AUTOSAVE_STATE_DIRECTORY, input.hash),
                    'utf8'
                )
                if (hashBytes(contents) !== input.hash) return null
                const manifest = parseChatStateManifest(contents)
                if (!manifest) return contents
                const readChunk = async (hash: string): Promise<unknown> => {
                    const chunk = await fileSystem.readFile(
                        join(repository.directory, AUTOSAVE_STATE_DIRECTORY, hash),
                        'utf8'
                    )
                    if (hashBytes(chunk) !== hash) {
                        throw new Error('Chat state chunk is corrupt')
                    }
                    return chatUnpacker.unpack(Buffer.from(chunk, 'base64'))
                }
                const header = await readChunk(manifest.header)
                const message: unknown[] = []
                for (const hash of manifest.messages) {
                    message.push(await readChunk(hash))
                }
                return chatPacker.pack({ ...(header as object), message })
                    .toString('base64')
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
                throw error
            }
        },

        async collectChatState(input: {
            characterId: string
            chatId: string
            referencedHashes: readonly string[]
            dryRun?: boolean
        }): Promise<{ deletedObjects: number; deletedBytes: number }> {
            const { repository } = await ensureRepositoryForChat(
                input.characterId, input.chatId
            )
            const directory = join(repository.directory, AUTOSAVE_STATE_DIRECTORY)
            const referenced = new Set(input.referencedHashes)
            for (const kind of REF_KINDS) {
                const refsDirectory = refDirectoryFor(repository, kind as WikiRefKind)
                for (const name of await readDirectory(fileSystem, refsDirectory)) {
                    if (!name.endsWith('.json')) continue
                    const ref = parseRefRecord(await readJson<unknown>(
                        fileSystem, join(refsDirectory, name)
                    ))
                    if (ref?.chatStateRef) referenced.add(ref.chatStateRef)
                }
            }
            for (const hash of referenced) {
                if (!HASH_PATTERN.test(hash)) throw new Error('Invalid chat state root')
                const contents = await fileSystem.readFile(
                    join(directory, hash), 'utf8'
                )
                if (hashBytes(contents) !== hash) {
                    throw new Error('Chat state root is corrupt')
                }
                const manifest = parseChatStateManifest(contents)
                if (!manifest) continue
                referenced.add(manifest.header)
                for (const chunk of manifest.messages) referenced.add(chunk)
            }
            let deletedObjects = 0
            let deletedBytes = 0
            for (const name of await readDirectory(fileSystem, directory)) {
                if (!HASH_PATTERN.test(name) || referenced.has(name)) continue
                const target = join(directory, name)
                if (!input.dryRun) {
                    const status = await fileSystem.lstat(target)
                    deletedBytes += status.size
                    await fileSystem.rm(target, { force: true })
                }
                deletedObjects += 1
            }
            return { deletedObjects, deletedBytes }
        },

        /**
         * Replays only journals owned by this exact chat branch. A prepared
         * materialization is completed without replacing edits made after the
         * journal was durable.
         */
        async recoverOperations(input: {
            characterId: string
            chatId: string
        }): Promise<{
            completed: string[]
            discarded: string[]
            unresolved: string[]
            conflicts?: string[]
        }> {
            const { repository, branch: initialBranch } =
                await ensureRepositoryForChat(input.characterId, input.chatId, true)
            let branch = initialBranch
            const completed: string[] = []
            const discarded: string[] = []
            const conflicts: string[] = []
            const unresolved: string[] = []
            for (const name of (await readDirectory(
                fileSystem, repository.operationsDirectory
            )).sort()) {
                const journalFile = join(
                    repository.operationsDirectory, name, JOURNAL_FILE
                )
                const raw = await readJson<unknown>(fileSystem, journalFile)
                if (raw === undefined) continue
                const journal = parseJournal(raw)
                if (!journal) {
                    unresolved.push(name)
                    continue
                }
                if (journal.characterId !== input.characterId
                    || journal.chatId !== input.chatId
                    || journal.branchId !== branch.id
                    || journal.published) continue
                if (!journal.prepared) {
                    try {
                        await removeFileDurably(fileSystem, journalFile)
                    }
                    catch (error) {
                        invalidatePendingOperationCache(repository)
                        throw error
                    }
                    removePendingOperationFromCache(
                        repository, journal.operationId
                    )
                    discarded.push(journal.operationId)
                    continue
                }
                const commit = await readCommit(repository, journal.commitId)
                if (!commit || (journal.mode !== 'checkout'
                    && commit.operationId !== journal.operationId)) {
                    unresolved.push(journal.operationId)
                    continue
                }
                if (branch.head !== journal.previousHead
                    && branch.head !== journal.commitId) {
                    unresolved.push(journal.operationId)
                    continue
                }
                if (journal.mode === 'publish' || journal.mode === 'checkout') {
                    try {
                        await completeMaterialization(repository, branch, journal)
                    }
                    catch (error) {
                        if (!(error instanceof WikiMaterializationConflictError)) {
                            throw error
                        }
                        unresolved.push(journal.operationId)
                        conflicts.push(error.message)
                        continue
                    }
                }
                else {
                    if (branch.head !== journal.commitId) {
                        await writeBranchHead(repository, branch, journal.commitId)
                    }
                    if (journal.mode === 'baseline') {
                        await writeLinkFor(
                            repository,
                            branch,
                            journal.commitId,
                            await pathMapFor(repository, journal.commitId)
                        )
                    }
                    const receiptFile = join(
                        repository.operationsDirectory,
                        journal.operationId,
                        'receipt.json'
                    )
                    const receipt = await readJson<WikiOperationReceipt>(
                        fileSystem, receiptFile
                    )
                    if (!receipt || receipt.status !== 'completed') {
                        await writeFileAtomically(
                            fileSystem,
                            receiptFile,
                            `${JSON.stringify({
                                schemaVersion: 1,
                                operationId: journal.operationId,
                                status: 'completed',
                                branchId: journal.branchId,
                                chatId: journal.chatId,
                                characterId: journal.characterId,
                                commitId: journal.commitId,
                                previousHead: journal.previousHead,
                                changedPaths: journal.changedPaths,
                                checkpointCreated: journal.checkpointCreated,
                                createdAt: journal.createdAt,
                            } satisfies WikiOperationReceipt, null, 2)}\n`
                        )
                    }
                    await writeJournal(repository, { ...journal, published: true })
                }
                branch = await readBranch(repository, branch.id) ?? branch
                completed.push(journal.operationId)
            }
            return {
                completed, discarded, unresolved,
                ...(conflicts.length > 0 ? { conflicts } : {}),
            }
        },

        /**
         * Removes unreachable blobs. Roots are branch heads, remaining refs
         * and unfinished operations, so live data cannot be collected.
         */
        async collectGarbage(input: {
            characterId: string
            chatId: string
            dryRun?: boolean
        }): Promise<{ deletedObjects: number; deletedBytes: number }> {
            const { repository } = await ensureRepositoryForChat(
                input.characterId, input.chatId
            )
            const roots = new Set<string>()
            const visitedCommits = new Set<string>()
            const retainCommitHistory = async (head: string): Promise<void> => {
                let cursor: string | null = head
                while (cursor && !visitedCommits.has(cursor)) {
                    visitedCommits.add(cursor)
                    const commit = await requireCommit(repository, cursor)
                    for (const change of commit.changes) {
                        if (change.before) roots.add(change.before)
                        if (change.after) roots.add(change.after)
                    }
                    cursor = commit.parent
                }
            }
            for (const name of await readDirectory(
                fileSystem, repository.branchesDirectory
            )) {
                if (!name.endsWith('.json')) continue
                const branch = parseBranchRecord(await readJson<unknown>(
                    fileSystem, join(repository.branchesDirectory, name)
                ))
                if (!branch?.head) continue
                await retainCommitHistory(branch.head)
            }
            for (const kind of ['save', 'recovery', 'autosave'] as const) {
                const directory = refDirectoryFor(repository, kind)
                for (const name of await readDirectory(fileSystem, directory)) {
                    if (!name.endsWith('.json')) continue
                    const record = parseRefRecord(
                        await readJson<unknown>(fileSystem, join(directory, name))
                    )
                    if (!record) continue
                    await retainCommitHistory(record.commitId)
                }
            }
            for (const name of await readDirectory(
                fileSystem, repository.operationsDirectory
            )) {
                const receipt = await readJson<WikiOperationReceipt>(
                    fileSystem,
                    join(repository.operationsDirectory, name, 'receipt.json')
                )
                if (receipt?.status === 'completed') continue
                const journal = parseJournal(await readJson<unknown>(
                    fileSystem,
                    join(repository.operationsDirectory, name, JOURNAL_FILE)
                ))
                if (journal?.prepared) {
                    await retainCommitHistory(journal.commitId)
                }
            }
            let deletedObjects = 0
            let deletedBytes = 0
            for (const prefix of await readDirectory(
                fileSystem, repository.objectsDirectory
            )) {
                if (!/^[a-f0-9]{2}$/.test(prefix)) continue
                const directory = join(repository.objectsDirectory, prefix)
                for (const name of await readDirectory(fileSystem, directory)) {
                    if (!HASH_PATTERN.test(name) || roots.has(name)) continue
                    const target = join(directory, name)
                    if (!input.dryRun) {
                        const status = await fileSystem.lstat(target)
                        deletedBytes += status.size
                        await fileSystem.rm(target, { force: true })
                    }
                    deletedObjects += 1
                }
            }
            return { deletedObjects, deletedBytes }
        },
    }
    return service
}

export interface WikiVcsService {
    ensureRepository(characterId: string, chatId: string): Promise<{
        branchId: string
        head: string | null
    }>
    readLink(characterId: string, chatId: string): Promise<WikiChatLink | undefined>
    discardChatBranch(characterId: string, chatId: string): Promise<void>
    discardUnpublishedOperation(input: {
        characterId: string
        chatId: string
        operationId: string
    }): Promise<void>
    listDeletedRecovery(characterId: string): Promise<WikiRefRecord[]>
    readCommit(
        characterId: string,
        chatId: string,
        commitId: string
    ): Promise<WikiCommitRecord | undefined>
    readPathMap(
        characterId: string,
        chatId: string,
        commitId: string
    ): Promise<Record<string, string>>
    commit(input: WikiCommitRequest): Promise<WikiOperationReceipt>
    publishChanges(input: WikiPublishChangesRequest): Promise<WikiPublishChangesResult>
    captureExternalChanges(input: {
        characterId: string
        chatId: string
        chatAnchor: WikiChatAnchor
        operationId?: string
        kind?: WikiCommitKind
        analysisReceiptRef?: string
        provenance?: WikiCommitProvenance
        expectedHead?: string | null
    }): Promise<{ commitId: string | null; changedPaths: string[] }>
    ensureBaseline(input: {
        characterId: string
        chatId: string
        chatAnchor: WikiChatAnchor
        operationId?: string
    }): Promise<{ created: boolean; commitId: string | null; branchId: string }>
    listHistory(input: {
        characterId: string
        chatId: string
        limit?: number
    }): Promise<WikiHistoryEntry[]>
    previewCheckout(input: {
        characterId: string
        chatId: string
        commitId: string
        messages?: readonly WikiAnchorMessage[]
        prefixes?: readonly WikiPrefixCheckpoint[]
    }): Promise<WikiCheckoutPreview>
    checkout(input: {
        characterId: string
        chatId: string
        commitId: string
        reason?: WikiRecoveryReason
        chatAnchor?: WikiChatAnchor
    }): Promise<{
        branchId: string
        commitId: string
        previousHead: string | null
        changedPaths: string[]
        recoveryRefId: string | null
    }>
    createRef(input: {
        characterId: string
        chatId?: string
        chatStateRef?: string
        commitId: string
        kind: WikiRefKind
        reason?: WikiRecoveryReason
        label?: string
        id?: string
    }): Promise<string>
    listRefs(input: {
        characterId: string
        chatId: string
        kind: WikiRefKind
    }): Promise<WikiRefRecord[]>
    deleteRef(input: {
        characterId: string
        chatId: string
        kind: WikiRefKind
        id: string
    }): Promise<void>
    fork(input: {
        characterId: string
        sourceChatId: string
        destinationChatId: string
        commitId: string
    }): Promise<{ branchId: string; commitId: string; changedPaths: string[] }>
    findCommitForPrefixes(input: {
        characterId: string
        chatId: string
        prefixes: readonly WikiPrefixCheckpoint[]
        minimumBoundaryMessageId?: string | null
    }): Promise<string | null>
    /**
     * Stores chat recovery bytes for a save and returns their content hash.
     * The bytes are deduplicated by hash, so repeated autosaves of an
     * unchanged chat add no storage.
     */
    storeChatState(input: {
        characterId: string
        chatId: string
        contents: string
    }): Promise<string>
    readChatState(input: {
        characterId: string
        chatId: string
        hash: string
    }): Promise<string | null>
    /** Removes chat-state objects not referenced by any remaining ref. */
    collectChatState(input: {
        characterId: string
        chatId: string
        referencedHashes: readonly string[]
        dryRun?: boolean
    }): Promise<{ deletedObjects: number; deletedBytes: number }>
    collectGarbage(input: {
        characterId: string
        chatId: string
        dryRun?: boolean
    }): Promise<{ deletedObjects: number; deletedBytes: number }>
    /** Finishes or discards operations interrupted mid-publish. */
    recoverOperations(input: {
        characterId: string
        chatId: string
    }): Promise<{
        completed: string[]
        discarded: string[]
        unresolved: string[]
        conflicts?: string[]
    }>
}
