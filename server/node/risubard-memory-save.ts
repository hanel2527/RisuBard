import * as nodeFs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
    completeMemoryWorkspaceFork,
    forkMemoryWorkspace,
    replaceMemoryWorkspace,
    resolveMemoryReplacementStaging,
    type MemoryForkReceipt,
} from './risubard-memory-fork'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import { resolveWikiVcsRepository } from './risubard-wiki-vcs'

const SAVE_MANIFEST = 'risubard-save.json'
const SAVE_CHAT = 'chat.bin'
/**
 * VCS metadata lives beside the v1 manifest, never inside it: the manifest
 * parser rejects unknown keys and older builds must keep reading these saves.
 */
const SAVE_VCS_SIDECAR = 'risubard-save-vcs.json'
const SAVE_PREFIX = 'save-slot:'
const SAVE_DIRECTORY_PREFIX = `id-${Buffer.from(
    SAVE_PREFIX.slice(0, -1), 'utf8'
).toString('base64url')}`

export interface MemorySaveEventPreview {
    title: string
    excerpt: string
}

export interface MemorySaveSlotSummary {
    saveId: string
    sourceChatId: string
    sourceChatName: string
    createdAt: string
    turnCount: number
    latestMessageId?: string
    latestEvent?: MemorySaveEventPreview
}

interface StoredMemorySaveManifest extends MemorySaveSlotSummary {
    schemaVersion: 1
}

export type MemorySaveMode = 'v1-snapshot' | 'commit-reference'

/**
 * Sidecar describing how a save relates to the version store. Absence means a
 * plain v1 snapshot, which is always a valid save.
 */
export interface MemorySaveVcsSidecar {
    schemaVersion: 1
    mode: MemorySaveMode
    saveId: string
    sourceChatId: string
    /** Commit the wiki working tree was at when the save was written. */
    commitId?: string
    branchId?: string
    head?: string
    chatStateRef?: string
    wikiRefId?: string
    manifestHash?: string
    chatHash?: string
    createdAt: string
}

/**
 * Reference save written next to the chat instead of copying the whole
 * workspace. It points at a wiki commit and a deduplicated chat state object,
 * so periodic autosaves stop paying full-copy cost. Files in this format are
 * not readable by builds that predate the version store; those builds get a
 * v1 export instead.
 */
export interface MemorySaveReferenceRecord {
    schemaVersion: 1
    mode: 'commit-reference'
    saveId: string
    sourceChatId: string
    sourceChatName: string
    createdAt: string
    turnCount: number
    latestMessageId?: string
    latestEvent?: MemorySaveEventPreview
    wikiCommitId?: string
    branchId?: string
    chatStateRef?: string
    /** Wiki tree revision pinned with the chat state. */
    wikiRevision?: string
}

const SAVE_REFERENCE_MANIFEST = 'risubard-save-reference.json'

type SaveFileSystem = Pick<
    typeof nodeFs,
    'lstat' | 'mkdir' | 'readdir' | 'readFile' | 'rm' | 'writeFile'
    | 'copyFile' | 'rename' | 'realpath'
>

function required(value: unknown, label: string, maximum = 1_024): string {
    if (typeof value !== 'string'
        || value.trim().length === 0
        || value.length > maximum) {
        throw new Error(`${label} must be a non-empty bounded string`)
    }
    return value
}

export function memorySaveWorkspaceId(saveId: string): string {
    return `${SAVE_PREFIX}${required(saveId, 'saveId')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEventPreview(value: unknown): MemorySaveEventPreview {
    if (!isRecord(value)
        || Object.keys(value).length !== 2
        || typeof value.title !== 'string'
        || value.title.trim().length === 0
        || value.title.length > 512
        || typeof value.excerpt !== 'string'
        || value.excerpt.length > 1_000) {
        throw new Error('Invalid memory save event preview')
    }
    return { title: value.title, excerpt: value.excerpt }
}

function parseManifest(value: unknown): StoredMemorySaveManifest {
    if (!isRecord(value)) throw new Error('Invalid memory save manifest')
    const hasEvent = value.latestEvent !== undefined
    const hasLatestMessageId = value.latestMessageId !== undefined
    const keys = [
        'schemaVersion', 'saveId', 'sourceChatId', 'sourceChatName',
        'createdAt', 'turnCount',
        ...(hasLatestMessageId ? ['latestMessageId'] : []),
        ...(hasEvent ? ['latestEvent'] : []),
    ]
    if (Object.keys(value).length !== keys.length
        || !keys.every((key) => Object.hasOwn(value, key))
        || value.schemaVersion !== 1
        || typeof value.saveId !== 'string'
        || typeof value.sourceChatId !== 'string'
        || typeof value.sourceChatName !== 'string'
        || typeof value.createdAt !== 'string'
        || !Number.isFinite(Date.parse(value.createdAt))
        || !Number.isSafeInteger(value.turnCount)
        || (value.turnCount as number) < 0) {
        throw new Error('Invalid memory save manifest')
    }
    return {
        schemaVersion: 1,
        saveId: required(value.saveId, 'saved saveId'),
        sourceChatId: required(value.sourceChatId, 'saved sourceChatId'),
        sourceChatName: required(value.sourceChatName, 'saved chat name', 512),
        createdAt: value.createdAt,
        turnCount: value.turnCount as number,
        ...(hasLatestMessageId ? {
            latestMessageId: required(
                value.latestMessageId,
                'saved latest message ID'
            ),
        } : {}),
        ...(hasEvent ? { latestEvent: parseEventPreview(value.latestEvent) } : {}),
    }
}

function summaryOf(manifest: StoredMemorySaveManifest): MemorySaveSlotSummary {
    const { schemaVersion: _schemaVersion, ...summary } = manifest
    return summary
}

function workspaceFor(
    userDataDirectory: string,
    characterId: string,
    saveId: string
) {
    return resolveMemoryWorkspace(
        userDataDirectory,
        characterId,
        memorySaveWorkspaceId(saveId)
    )
}

async function safeFile(
    fileSystem: SaveFileSystem,
    path: string,
    label: string
): Promise<void> {
    const status = await fileSystem.lstat(path)
    if (status.isSymbolicLink() || !status.isFile()) {
        throw new Error(`${label} is unsafe`)
    }
}

async function validatedSave(
    fileSystem: SaveFileSystem,
    input: { userDataDirectory: string; characterId: string; saveId: string }
): Promise<{
    directory: string
    manifestPath: string
    chatPath: string
    manifest: StoredMemorySaveManifest
}> {
    const characterId = required(input.characterId, 'characterId')
    const saveId = required(input.saveId, 'saveId')
    const workspace = workspaceFor(input.userDataDirectory, characterId, saveId)
    const manifestPath = join(workspace.directory, SAVE_MANIFEST)
    const chatPath = join(workspace.directory, SAVE_CHAT)
    await safeFile(fileSystem, manifestPath, 'Memory save manifest')
    await safeFile(fileSystem, chatPath, 'Memory save chat')
    const manifest = parseManifest(JSON.parse(
        await fileSystem.readFile(manifestPath, 'utf8')
    ))
    if (manifest.saveId !== saveId) {
        throw new Error('Invalid memory save manifest')
    }
    return {
        directory: workspace.directory,
        manifestPath,
        chatPath,
        manifest,
    }
}

export async function createMemorySaveSlot(input: {
    userDataDirectory: string
    characterId: string
    sourceChatId: string
    /** Internal export source; the manifest still belongs to sourceChatId. */
    workspaceSourceChatId?: string
    saveId: string
    overwrite?: boolean
    sourceChatName: string
    turnCount: number
    latestMessageId?: string
    chatBytes: Uint8Array
    createdAt?: string
    latestEvent?: MemorySaveEventPreview
    /** Optional version-store linkage; absent writes a plain v1 save. */
    vcs?: Omit<MemorySaveVcsSidecar, 'schemaVersion' | 'saveId' | 'sourceChatId' | 'createdAt'>
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<MemorySaveSlotSummary> {
    const fileSystem = options.fileSystem ?? nodeFs
    const saveId = required(input.saveId, 'saveId')
    const sourceChatId = required(input.sourceChatId, 'sourceChatId')
    let sourceChatName = required(input.sourceChatName, 'sourceChatName', 512)
    if (input.overwrite) {
        const reference = await readMemorySaveReference(input, { fileSystem })
        if (reference) {
            if (reference.sourceChatId !== sourceChatId) {
                throw new Error('Cannot overwrite a save from a different chat')
            }
            sourceChatName = required(
                reference.sourceChatName, 'saved chat name', 512
            )
        }
        else {
            const saved = await validatedSave(fileSystem, input)
            if (saved.manifest.sourceChatId !== sourceChatId) {
                throw new Error('Cannot overwrite a save from a different chat')
            }
            sourceChatName = saved.manifest.sourceChatName
        }
    }
    if (!Number.isSafeInteger(input.turnCount) || input.turnCount < 0) {
        throw new Error('turnCount must be a non-negative safe integer')
    }
    if (!(input.chatBytes instanceof Uint8Array)
        || input.chatBytes.byteLength === 0) {
        throw new Error('chatBytes must not be empty')
    }
    const createdAt = input.createdAt ?? new Date().toISOString()
    if (!Number.isFinite(Date.parse(createdAt))) {
        throw new Error('createdAt must be an ISO-compatible date')
    }
    const manifest: StoredMemorySaveManifest = {
        schemaVersion: 1,
        saveId,
        sourceChatId,
        sourceChatName,
        createdAt,
        turnCount: input.turnCount,
        ...(input.latestMessageId ? {
            latestMessageId: required(
                input.latestMessageId,
                'latestMessageId'
            ),
        } : {}),
        ...(input.latestEvent
            ? { latestEvent: parseEventPreview(input.latestEvent) }
            : {}),
    }
    const destinationChatId = memorySaveWorkspaceId(saveId)
    let receipt: MemoryForkReceipt | undefined
    try {
        const forkInput = {
            userDataDirectory: input.userDataDirectory,
            characterId: required(input.characterId, 'characterId'),
            sourceChatId: input.workspaceSourceChatId
                ? required(input.workspaceSourceChatId, 'workspaceSourceChatId')
                : sourceChatId,
            destinationChatId,
        }
        receipt = input.overwrite
            ? await replaceMemoryWorkspace(forkInput, { fileSystem })
            : await forkMemoryWorkspace({ ...forkInput, mode: 'copy' }, { fileSystem })
        const directory = input.overwrite
            ? resolveMemoryReplacementStaging(
                input.userDataDirectory, input.characterId,
                destinationChatId, receipt.forkToken
            )
            : workspaceFor(input.userDataDirectory, input.characterId, saveId).directory
        await fileSystem.writeFile(
            join(directory, SAVE_CHAT),
            input.chatBytes,
            { flag: 'wx', mode: 0o600 }
        )
        await fileSystem.writeFile(
            join(directory, SAVE_MANIFEST),
            JSON.stringify(manifest),
            { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        )
        // The sidecar records how the snapshot relates to version history but
        // never changes what a v1 reader sees.
        if (input.vcs) {
            const sidecar: MemorySaveVcsSidecar = {
                schemaVersion: 1,
                mode: 'v1-snapshot',
                saveId,
                sourceChatId,
                ...input.vcs,
                createdAt,
            }
            await fileSystem.writeFile(
                join(directory, SAVE_VCS_SIDECAR),
                JSON.stringify(sidecar),
                { encoding: 'utf8', flag: 'wx', mode: 0o600 }
            )
        }
        await completeMemoryWorkspaceFork({
            userDataDirectory: input.userDataDirectory,
            characterId: input.characterId,
            destinationChatId,
            forkToken: receipt.forkToken,
            action: 'finalize',
        }, { fileSystem })
        return summaryOf(manifest)
    }
    catch (error) {
        if (receipt) {
            await completeMemoryWorkspaceFork({
                userDataDirectory: input.userDataDirectory,
                characterId: input.characterId,
                destinationChatId,
                forkToken: receipt.forkToken,
                action: 'discard',
            }, { fileSystem }).catch(() => undefined)
        }
        throw error
    }
}

export async function listMemorySaveSlots(input: {
    userDataDirectory: string
    characterId: string
    sourceChatId: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<MemorySaveSlotSummary[]> {
    const fileSystem = options.fileSystem ?? nodeFs
    const sourceChatId = required(input.sourceChatId, 'sourceChatId')
    const probe = resolveMemoryWorkspace(
        input.userDataDirectory,
        required(input.characterId, 'characterId'),
        'save-list-probe'
    )
    const chatsDirectory = dirname(probe.directory)
    let entries
    try {
        entries = await fileSystem.readdir(chatsDirectory, { withFileTypes: true })
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
    }
    const summaries: MemorySaveSlotSummary[] = []
    for (const entry of entries) {
        if (!entry.isDirectory()
            || entry.isSymbolicLink()
            || !entry.name.startsWith(SAVE_DIRECTORY_PREFIX)) continue
        const directory = join(chatsDirectory, entry.name)
        const manifestPath = join(directory, SAVE_MANIFEST)
        const chatPath = join(directory, SAVE_CHAT)
        try {
            await safeFile(fileSystem, manifestPath, 'Memory save manifest')
            await safeFile(fileSystem, chatPath, 'Memory save chat')
            const manifest = parseManifest(JSON.parse(
                await fileSystem.readFile(manifestPath, 'utf8')
            ))
            if (manifest.sourceChatId !== sourceChatId) continue
            if (workspaceFor(
                input.userDataDirectory, input.characterId, manifest.saveId
            ).directory !== directory) continue
            summaries.push(summaryOf(manifest))
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            if (error instanceof SyntaxError
                || (error instanceof Error
                    && error.message.startsWith('Invalid memory save'))) continue
            throw error
        }
    }
    return summaries.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
        || left.saveId.localeCompare(right.saveId)
    )
}

export async function readMemorySaveChat(input: {
    userDataDirectory: string
    characterId: string
    saveId: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<Buffer> {
    const fileSystem = options.fileSystem ?? nodeFs
    const saved = await validatedSave(fileSystem, input)
    return Buffer.from(await fileSystem.readFile(saved.chatPath))
}

/**
 * Reads the optional version sidecar. A missing or unreadable sidecar is not an
 * error: that save is simply a plain v1 snapshot.
 */
export async function readMemorySaveVcsSidecar(input: {
    userDataDirectory: string
    characterId: string
    saveId: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<MemorySaveVcsSidecar | null> {
    const fileSystem = options.fileSystem ?? nodeFs
    const saveId = required(input.saveId, 'saveId')
    const workspace = workspaceFor(input.userDataDirectory, input.characterId, saveId)
    const sidecarPath = join(workspace.directory, SAVE_VCS_SIDECAR)
    let contents: string
    try {
        contents = await fileSystem.readFile(sidecarPath, 'utf8')
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    }
    const value: unknown = JSON.parse(contents)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null
    }
    const sidecar = value as Partial<MemorySaveVcsSidecar>
    if (sidecar.schemaVersion !== 1
        || sidecar.mode !== 'v1-snapshot'
        || sidecar.saveId !== saveId
        || typeof sidecar.sourceChatId !== 'string') {
        return null
    }
    return sidecar as MemorySaveVcsSidecar
}

/**
 * True when the sidecar references version-store objects that are missing
 * locally, so callers can fall back to the embedded Markdown instead of
 * claiming exact history.
 */
export async function memorySaveVcsObjectsAvailable(input: {
    userDataDirectory: string
    characterId: string
    saveId: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<boolean> {
    const sidecar = await readMemorySaveVcsSidecar(input, options)
    if (!sidecar?.commitId) return false
    const fileSystem = options.fileSystem ?? nodeFs
    const repository = resolveWikiVcsRepository(
        input.userDataDirectory,
        input.characterId,
        memorySaveWorkspaceId(input.saveId)
    )
    try {
        await fileSystem.lstat(join(
            repository.commitsDirectory, `${sidecar.commitId}.json`
        ))
        return true
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
    }
}

export async function renameMemorySaveSlot(input: {
    userDataDirectory: string
    characterId: string
    saveId: string
    name: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<MemorySaveSlotSummary> {
    const fileSystem = options.fileSystem ?? nodeFs
    const name = required(input.name, 'saved file name', 512)
    const saved = await validatedSave(fileSystem, input)
    const manifest: StoredMemorySaveManifest = {
        ...saved.manifest,
        sourceChatName: name,
    }
    await fileSystem.writeFile(
        saved.manifestPath,
        JSON.stringify(manifest),
        { encoding: 'utf8', mode: 0o600 }
    )
    return summaryOf(manifest)
}

export async function deleteMemorySaveSlot(input: {
    userDataDirectory: string
    characterId: string
    saveId: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<void> {
    const fileSystem = options.fileSystem ?? nodeFs
    try {
        const saved = await validatedSave(fileSystem, input)
        await fileSystem.rm(saved.directory, { recursive: true, force: false })
        return
    }
    catch (error) {
        // A reference-only slot has no v1 manifest; remove it by directory.
        if (!(error instanceof Error)
            || !error.message.startsWith('Invalid memory save')) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
    }
    const workspace = workspaceFor(
        input.userDataDirectory, input.characterId, input.saveId
    )
    await fileSystem.rm(workspace.directory, { recursive: true, force: true })
}

/**
 * Writes a reference autosave: a manifest beside the chat plus a deduplicated
 * chat-state object in the version repository. No wiki tree is copied, which is
 * what makes periodic autosave affordable on long chats.
 */
export async function writeMemorySaveReference(input: {
    userDataDirectory: string
    characterId: string
    sourceChatId: string
    saveId: string
    sourceChatName: string
    turnCount: number
    chatStateRef: string
    wikiCommitId?: string
    branchId?: string
    wikiRevision?: string
    latestMessageId?: string
    latestEvent?: MemorySaveEventPreview
    createdAt?: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<MemorySaveReferenceRecord> {
    const fileSystem = options.fileSystem ?? nodeFs
    const saveId = required(input.saveId, 'saveId')
    const sourceChatId = required(input.sourceChatId, 'sourceChatId')
    if (!Number.isSafeInteger(input.turnCount) || input.turnCount < 0) {
        throw new Error('turnCount must be a non-negative safe integer')
    }
    const createdAt = input.createdAt ?? new Date().toISOString()
    if (!Number.isFinite(Date.parse(createdAt))) {
        throw new Error('createdAt must be an ISO-compatible date')
    }
    const record: MemorySaveReferenceRecord = {
        schemaVersion: 1,
        mode: 'commit-reference',
        saveId,
        sourceChatId,
        sourceChatName: required(input.sourceChatName, 'sourceChatName', 512),
        createdAt,
        turnCount: input.turnCount,
        chatStateRef: required(input.chatStateRef, 'chatStateRef'),
        ...(input.wikiCommitId ? { wikiCommitId: input.wikiCommitId } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
        ...(input.wikiRevision ? { wikiRevision: input.wikiRevision } : {}),
        ...(input.latestMessageId ? {
            latestMessageId: required(
                input.latestMessageId, 'latestMessageId'
            ),
        } : {}),
        ...(input.latestEvent
            ? { latestEvent: parseEventPreview(input.latestEvent) }
            : {}),
    }
    const workspace = workspaceFor(
        input.userDataDirectory, input.characterId, saveId
    )
    await fileSystem.mkdir(workspace.directory, { recursive: true })
    await fileSystem.writeFile(
        join(workspace.directory, SAVE_REFERENCE_MANIFEST),
        JSON.stringify(record),
        { encoding: 'utf8', flag: 'w', mode: 0o600 }
    )
    return record
}

/**
 * Renames a reference save in place. The v1 path keeps its own rename; this is
 * only for slots that store their label in the reference manifest.
 */
export async function renameMemorySaveReference(input: {
    userDataDirectory: string
    characterId: string
    saveId: string
    name: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<MemorySaveReferenceRecord> {
    const fileSystem = options.fileSystem ?? nodeFs
    const existing = await readMemorySaveReference(input, options)
    if (!existing) {
        throw new Error('Memory reference save does not exist')
    }
    const name = required(input.name, 'Saved file name', 512)
    const record: MemorySaveReferenceRecord = {
        ...existing,
        sourceChatName: name,
    }
    const workspace = workspaceFor(
        input.userDataDirectory, input.characterId, existing.saveId
    )
    await fileSystem.writeFile(
        join(workspace.directory, SAVE_REFERENCE_MANIFEST),
        JSON.stringify(record),
        { encoding: 'utf8', flag: 'w', mode: 0o600 }
    )
    return record
}

export async function readMemorySaveReference(input: {
    userDataDirectory: string
    characterId: string
    saveId: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<MemorySaveReferenceRecord | null> {
    const fileSystem = options.fileSystem ?? nodeFs
    const workspace = workspaceFor(
        input.userDataDirectory,
        input.characterId,
        required(input.saveId, 'saveId')
    )
    let contents: string
    try {
        contents = await fileSystem.readFile(
            join(workspace.directory, SAVE_REFERENCE_MANIFEST), 'utf8'
        )
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    }
    const value: unknown = JSON.parse(contents)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null
    }
    const record = value as Partial<MemorySaveReferenceRecord>
    if (record.schemaVersion !== 1
        || record.mode !== 'commit-reference'
        || typeof record.saveId !== 'string'
        || typeof record.sourceChatId !== 'string'
        || typeof record.chatStateRef !== 'string') {
        return null
    }
    return record as MemorySaveReferenceRecord
}

/**
 * Reference saves and v1 saves are listed together so the save dialog keeps
 * working unchanged; the summary shape is shared.
 */
export async function listMemorySaveReferences(input: {
    userDataDirectory: string
    characterId: string
    sourceChatId: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<MemorySaveSlotSummary[]> {
    const fileSystem = options.fileSystem ?? nodeFs
    const sourceChatId = required(input.sourceChatId, 'sourceChatId')
    const probe = resolveMemoryWorkspace(
        input.userDataDirectory,
        required(input.characterId, 'characterId'),
        'save-list-probe'
    )
    const chatsDirectory = dirname(probe.directory)
    let entries
    try {
        entries = await fileSystem.readdir(chatsDirectory, { withFileTypes: true })
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
    }
    const summaries: MemorySaveSlotSummary[] = []
    for (const entry of entries) {
        if (!entry.isDirectory()
            || entry.isSymbolicLink()
            || !entry.name.startsWith(SAVE_DIRECTORY_PREFIX)) continue
        const referencePath = join(
            chatsDirectory, entry.name, SAVE_REFERENCE_MANIFEST
        )
        let contents: string
        try {
            await safeFile(fileSystem, referencePath, 'Memory save reference')
            contents = await fileSystem.readFile(referencePath, 'utf8')
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            if (error instanceof Error
                && error.message.startsWith('Memory save reference')) continue
            throw error
        }
        let record: unknown
        try {
            record = JSON.parse(contents)
        }
        catch {
            continue
        }
        if (typeof record !== 'object' || record === null) continue
        const value = record as Partial<MemorySaveReferenceRecord>
        if (value.schemaVersion !== 1
            || value.mode !== 'commit-reference'
            || value.sourceChatId !== sourceChatId
            || typeof value.saveId !== 'string'
            || typeof value.createdAt !== 'string') {
            continue
        }
        summaries.push({
            saveId: value.saveId,
            sourceChatId: value.sourceChatId,
            sourceChatName: String(value.sourceChatName ?? ''),
            createdAt: value.createdAt,
            turnCount: Number.isSafeInteger(value.turnCount)
                ? value.turnCount as number
                : 0,
            ...(typeof value.latestMessageId === 'string'
                ? { latestMessageId: value.latestMessageId } : {}),
            ...(value.latestEvent ? { latestEvent: value.latestEvent } : {}),
        })
    }
    return summaries
}

/**
 * Merges both save formats for one chat. Reference entries win when a slot
 * exists in both, because that is the newer write for the same slot ID.
 */
export async function listAllMemorySaveSlots(input: {
    userDataDirectory: string
    characterId: string
    sourceChatId: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<Array<
    MemorySaveSlotSummary & { saveFormat: MemorySaveMode }
>> {
    const [versioned, references] = await Promise.all([
        listMemorySaveSlots(input, options),
        listMemorySaveReferences(input, options),
    ])
    const byId = new Map<string, MemorySaveSlotSummary & { saveFormat: MemorySaveMode }>()
    for (const slot of versioned) {
        byId.set(slot.saveId, { ...slot, saveFormat: 'v1-snapshot' })
    }
    for (const slot of references) {
        byId.set(slot.saveId, { ...slot, saveFormat: 'commit-reference' })
    }
    return [...byId.values()].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
        || left.saveId.localeCompare(right.saveId)
    )
}

export async function prepareMemorySaveLoad(input: {
    userDataDirectory: string
    characterId: string
    saveId: string
    destinationChatId: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<{
    chatBytes: Buffer
    save: MemorySaveSlotSummary
    fork: MemoryForkReceipt
    /** Wiki commit the save pinned, when it was a reference save. */
    wikiCommitId?: string
}> {
    const fileSystem = options.fileSystem ?? nodeFs
    const sourceChatId = memorySaveWorkspaceId(input.saveId)
    const workspace = workspaceFor(
        input.userDataDirectory, input.characterId, input.saveId
    )
    const manifestPath = join(workspace.directory, SAVE_MANIFEST)
    const chatPath = join(workspace.directory, SAVE_CHAT)
    const reference = await readMemorySaveReference(input, options)
    if (reference) {
        // Reference saves carry no wiki copy. The runtime materializes the
        // destination from the pinned commit instead of this v1 path.
        throw new Error(
            'Memory save reference is loaded through its pinned commit'
        )
    }
    await safeFile(fileSystem, manifestPath, 'Memory save manifest')
    await safeFile(fileSystem, chatPath, 'Memory save chat')
    const manifest = parseManifest(JSON.parse(
        await fileSystem.readFile(manifestPath, 'utf8')
    ))
    const chatBytes = Buffer.from(await fileSystem.readFile(chatPath))
    const fork = await replaceMemoryWorkspace({
        userDataDirectory: input.userDataDirectory,
        characterId: required(input.characterId, 'characterId'),
        sourceChatId,
        destinationChatId: required(
            input.destinationChatId, 'destinationChatId'
        ),
    }, { fileSystem: fileSystem as typeof nodeFs })
    try {
        const destinationDirectory = resolveMemoryReplacementStaging(
            input.userDataDirectory,
            input.characterId,
            input.destinationChatId,
            fork.forkToken
        )
        await fileSystem.rm(join(destinationDirectory, SAVE_MANIFEST), {
            force: false,
        })
        await fileSystem.rm(join(destinationDirectory, SAVE_CHAT), {
            force: false,
        })
        return { chatBytes, save: summaryOf(manifest), fork }
    }
    catch (error) {
        await completeMemoryWorkspaceFork({
            userDataDirectory: input.userDataDirectory,
            characterId: input.characterId,
            destinationChatId: input.destinationChatId,
            forkToken: fork.forkToken,
            action: 'discard',
        }).catch(() => undefined)
        throw error
    }
}

/** All save slots are GC roots, including references written before ref metadata. */
export async function memorySaveChatStateRoots(input: {
    userDataDirectory: string
    characterId: string
}): Promise<string[]> {
    const directory = dirname(resolveMemoryWorkspace(
        input.userDataDirectory, input.characterId, 'save-list-probe'
    ).directory)
    const roots: string[] = []
    let entries
    try { entries = await nodeFs.readdir(directory, { withFileTypes: true }) }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return roots
        throw error
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(SAVE_DIRECTORY_PREFIX)) continue
        for (const name of [SAVE_REFERENCE_MANIFEST, SAVE_VCS_SIDECAR]) {
            const file = join(directory, entry.name, name)
            try {
                await safeFile(nodeFs, file, 'Memory save GC root')
                const record = JSON.parse(await nodeFs.readFile(file, 'utf8'))
                if (typeof record.chatStateRef === 'string') roots.push(record.chatStateRef)
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
                throw error
            }
        }
    }
    return roots
}
