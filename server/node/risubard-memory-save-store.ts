import * as nodeFs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import fileStore from './file-store.cjs'
import type { Dirent } from 'node:fs'

const { atomicWriteFile } = fileStore

// Content-addressed page store for save slots. A slot lists its files as
// { path, hash }; unchanged pages are shared between slots, so a save only
// copies pages written since the previous one.

export const SAVE_FILES = 'risubard-save-files.json'
const EXCLUDED_NAMES = new Set(['.risubard-snapshots', '.risubard-history', '.risubard-recovery'])
const HASH_PATTERN = /^[0-9a-f]{64}$/

export interface SavedFileEntry {
    path: string
    hash: string
    size: number
}

export type SaveStoreFileSystem = Pick<
    typeof nodeFs,
    'lstat' | 'mkdir' | 'readdir' | 'readFile' | 'rename' | 'rm' | 'writeFile'
>

type HashedFile = { signature: string; hash: string; size: number }
// Absolute source path -> last hash, keyed by its stat stamp.
const hashedFiles = new Map<string, HashedFile>()
// Store directory -> blobs known to exist (written or verified here).
const knownBlobs = new Map<string, Set<string>>()
// Slot file list path -> referenced hashes, keyed by its stat stamp.
const slotReferences = new Map<string, { signature: string; hashes: Set<string> }>()

const stamp = (status: Awaited<ReturnType<SaveStoreFileSystem['lstat']>>) =>
    `${status.mtimeMs}:${status.ctimeMs}:${status.size}:${status.ino}`

/** Store shared by every save slot of one character: characters/<id>/save-store. */
export function saveStoreDirectory(slotWorkspaceDirectory: string): string {
    return join(dirname(dirname(slotWorkspaceDirectory)), 'save-store')
}

function blobPath(store: string, hash: string): string {
    if (!HASH_PATTERN.test(hash)) throw new Error('Invalid memory save page hash')
    return join(store, hash.slice(0, 2), hash)
}

function knownIn(store: string): Set<string> {
    let known = knownBlobs.get(store)
    if (!known) {
        known = new Set()
        knownBlobs.set(store, known)
    }
    return known
}

async function blobExists(
    fileSystem: SaveStoreFileSystem,
    store: string,
    hash: string
): Promise<boolean> {
    if (knownIn(store).has(hash)) return true
    try {
        const status = await fileSystem.lstat(blobPath(store, hash))
        if (status.isSymbolicLink() || !status.isFile()) {
            throw new Error('Memory save page store is unsafe')
        }
        knownIn(store).add(hash)
        return true
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
    }
}

// Identical files in one workspace hash to the same page; write it once.
const pendingBlobs = new Map<string, Promise<void>>()

function writeBlob(
    fileSystem: SaveStoreFileSystem,
    store: string,
    hash: string,
    contents: Uint8Array
): Promise<void> {
    const target = blobPath(store, hash)
    const pending = pendingBlobs.get(target)
    if (pending) return pending
    const write = writeBlobOnce(fileSystem, store, hash, contents)
        .finally(() => pendingBlobs.delete(target))
    pendingBlobs.set(target, write)
    return write
}

async function writeBlobOnce(
    fileSystem: SaveStoreFileSystem,
    store: string,
    hash: string,
    contents: Uint8Array
): Promise<void> {
    const target = blobPath(store, hash)
    await assertSafeSaveStorePath(fileSystem, dirname(target), store)
    await fileSystem.mkdir(dirname(target), { recursive: true })
    if (fileSystem === nodeFs) {
        atomicWriteFile(store, `${hash.slice(0, 2)}/${hash}`, contents)
        knownIn(store).add(hash)
        return
    }
    const temporary = `${target}.${randomUUID()}.tmp`
    await fileSystem.writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
    try {
        await fileSystem.rename(temporary, target)
    }
    catch (error) {
        await fileSystem.rm(temporary, { force: true }).catch(() => undefined)
        throw error
    }
    knownIn(store).add(hash)
}

/**
 * Records every file of a workspace in the store and returns its file list.
 * Files whose stat stamp is unchanged since the last save are not reread.
 */
export async function snapshotWorkspaceToStore(
    fileSystem: SaveStoreFileSystem,
    sourceDirectory: string,
    store: string
): Promise<SavedFileEntry[]> {
    const entries: SavedFileEntry[] = []
    const walk = async (directory: string, prefix: string): Promise<void> => {
        const names = await fileSystem.readdir(directory, { withFileTypes: true })
        await Promise.all(names.map(async (entry) => {
            if (EXCLUDED_NAMES.has(entry.name)) return
            const path = join(directory, entry.name)
            const relativePath = `${prefix}${entry.name}`
            const status = await fileSystem.lstat(path)
            if (status.isSymbolicLink()) {
                throw new Error('Memory save source contains a symbolic link')
            }
            if (status.isDirectory()) {
                await walk(path, `${relativePath}/`)
                return
            }
            if (!status.isFile()) {
                throw new Error('Memory save source contains a non-regular file')
            }
            const signature = stamp(status)
            const cached = hashedFiles.get(path)
            if (cached?.signature === signature
                && await blobExists(fileSystem, store, cached.hash)) {
                entries.push({ path: relativePath, hash: cached.hash, size: cached.size })
                return
            }
            const contents = await fileSystem.readFile(path)
            const hash = createHash('sha256').update(contents).digest('hex')
            if (!await blobExists(fileSystem, store, hash)) {
                await writeBlob(fileSystem, store, hash, contents)
            }
            hashedFiles.set(path, { signature, hash, size: contents.byteLength })
            entries.push({ path: relativePath, hash, size: contents.byteLength })
        }))
    }
    await walk(sourceDirectory, '')
    return entries.sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

export function parseSavedFiles(text: string): SavedFileEntry[] {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null
        || (value as { schemaVersion?: unknown }).schemaVersion !== 1
        || !Array.isArray((value as { files?: unknown }).files)) {
        throw new Error('Invalid memory save file list')
    }
    const seen = new Set<string>()
    return (value as { files: unknown[] }).files.map((item) => {
        const entry = item as Partial<SavedFileEntry>
        const segments = typeof entry.path === 'string' ? entry.path.split('/') : []
        if (segments.length === 0
            || segments.some((segment) => segment === '' || segment === '.'
                || segment === '..' || /[\\:\0]/.test(segment))
            || typeof entry.hash !== 'string' || !HASH_PATTERN.test(entry.hash)
            || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0
            || seen.has(entry.path as string)) {
            throw new Error('Invalid memory save file list')
        }
        seen.add(entry.path as string)
        return { path: entry.path as string, hash: entry.hash, size: entry.size as number }
    })
}

export function serializeSavedFiles(entries: readonly SavedFileEntry[]): string {
    return JSON.stringify({ schemaVersion: 1, files: entries })
}

/** Check managed directories only; OS aliases above the trusted root are allowed. */
export async function assertSafeSaveStorePath(
    fileSystem: SaveStoreFileSystem,
    path: string,
    root: string
): Promise<void> {
    const target = resolve(path)
    const boundary = resolve(root)
    const relation = relative(boundary, target)
    if (relation === '..' || relation.startsWith('../') || relation.startsWith('..\\') || isAbsolute(relation)) {
        throw new Error('Memory save store path escapes its root')
    }
    const parent = dirname(target)
    if (target !== boundary) await assertSafeSaveStorePath(fileSystem, parent, boundary)
    try {
        const status = await fileSystem.lstat(target)
        if (status.isSymbolicLink() || !status.isDirectory()) {
            throw new Error('Memory save store path is unsafe')
        }
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
}

/** Generic CAS bytes shared by wiki pages, messages, and flat history manifests. */
export async function putSaveBlob(
    fileSystem: SaveStoreFileSystem,
    store: string,
    contents: Uint8Array
): Promise<string> {
    const hash = createHash('sha256').update(contents).digest('hex')
    await assertSafeSaveStorePath(fileSystem, dirname(blobPath(store, hash)), store)
    if (!await blobExists(fileSystem, store, hash)) {
        await writeBlob(fileSystem, store, hash, contents)
    }
    return hash
}

export async function readSaveBlob(
    fileSystem: SaveStoreFileSystem,
    store: string,
    hash: string
): Promise<Buffer> {
    const path = blobPath(store, hash)
    await assertSafeSaveStorePath(fileSystem, dirname(path), store)
    const status = await fileSystem.lstat(path)
    if (status.isSymbolicLink() || !status.isFile()) {
        throw new Error('Memory save page store is unsafe')
    }
    const contents = Buffer.from(await fileSystem.readFile(path))
    if (createHash('sha256').update(contents).digest('hex') !== hash) {
        throw new Error('Memory save page is damaged')
    }
    return contents
}

/** Rebuilds a workspace from a slot's file list, verifying every page. */
export async function restoreWorkspaceFromStore(
    fileSystem: SaveStoreFileSystem,
    entries: readonly SavedFileEntry[],
    store: string,
    destination: string
): Promise<void> {
    const safeEntries = parseSavedFiles(serializeSavedFiles(entries))
    for (const entry of safeEntries) {
        const contents = await readSaveBlob(fileSystem, store, entry.hash)
        if (contents.byteLength !== entry.size) {
            throw new Error('Memory save page is damaged')
        }
        const target = join(destination, ...entry.path.split('/'))
        await fileSystem.mkdir(dirname(target), { recursive: true })
        await fileSystem.writeFile(target, contents, { flag: 'wx' })
    }
}

async function referencedHashes(
    fileSystem: SaveStoreFileSystem,
    filesPath: string
): Promise<Set<string>> {
    let status: Awaited<ReturnType<SaveStoreFileSystem['lstat']>>
    try {
        status = await fileSystem.lstat(filesPath)
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
        throw error
    }
    const cached = slotReferences.get(filesPath)
    if (cached?.signature === stamp(status)) return cached.hashes
    const hashes = new Set(parseSavedFiles(
        await fileSystem.readFile(filesPath, 'utf8')
    ).map((entry) => entry.hash))
    slotReferences.set(filesPath, { signature: stamp(status), hashes })
    return hashes
}

/**
 * Removes candidate pages that no slot in `slotDirectories` references.
 * Only pages a replaced or deleted slot used are candidates, so the cost
 * follows what changed rather than the size of the store.
 */
export async function releaseStorePages(
    fileSystem: SaveStoreFileSystem,
    store: string,
    candidates: Iterable<string>,
    slotDirectories: readonly string[]
): Promise<void> {
    const pending = new Set(candidates)
    if (pending.size === 0) return
    for (const directory of slotDirectories) {
        for (const hash of await referencedHashes(fileSystem, join(directory, SAVE_FILES))) {
            pending.delete(hash)
        }
        if (pending.size === 0) return
    }
    // History retains all records, including deactivated rollback archives and
    // in-flight wiki/checkout recovery manifests. Fail closed on damaged pins.
    const historyRoot = join(dirname(store), 'story-history')
    await assertSafeSaveStorePath(fileSystem, historyRoot, dirname(store))
    let histories: Dirent[]
    try {
        histories = await fileSystem.readdir(historyRoot, { withFileTypes: true })
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        histories = []
    }
    for (const entry of histories) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
            throw new Error('Story history pin directory is unsafe')
        }
        const statePath = join(historyRoot, entry.name, 'state.json')
        const status = await fileSystem.lstat(statePath)
        if (!status.isFile() || status.isSymbolicLink()) {
            throw new Error('Story history pin file is unsafe')
        }
        const contents = await fileSystem.readFile(statePath, 'utf8')
        const checksumPath = `${statePath}.sha256`
        const checksumStatus = await fileSystem.lstat(checksumPath)
        if (!checksumStatus.isFile() || checksumStatus.isSymbolicLink()
            || (await fileSystem.readFile(checksumPath, 'utf8')).trim()
                !== createHash('sha256').update(contents).digest('hex')) {
            throw new Error('Story history pin checksum is damaged')
        }
        const state = JSON.parse(contents)
        if (state.schemaVersion !== 1 || !Array.isArray(state.pinnedHashes)
            || state.pinnedHashes.some((hash: unknown) =>
                typeof hash !== 'string' || !HASH_PATTERN.test(hash))) {
            throw new Error('Story history pins are damaged')
        }
        for (const hash of state.pinnedHashes) pending.delete(hash)
        if (pending.size === 0) return
    }
    for (const hash of pending) {
        const path = blobPath(store, hash)
        await Promise.all(['', '.sha256', '.bak', '.bak.sha256'].map(suffix =>
            fileSystem.rm(`${path}${suffix}`, { force: true })))
        knownIn(store).delete(hash)
    }
}
