import * as fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Packr, Unpackr } from 'msgpackr'
import { listMemorySaveSlots, memorySaveWorkspaceId, readMemorySaveChat } from './risubard-memory-save'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import { parseSavedFiles, SAVE_FILES, saveStoreDirectory, serializeSavedFiles, snapshotWorkspaceToStore, type SavedFileEntry } from './risubard-memory-save-store'
import type { StoryHistoryService } from './risubard-story-history'
import fileStore from './file-store.cjs'

const { commitTransaction, recoverTransactions } = fileStore
const packer = new Packr({ useRecords: false })
const unpacker = new Unpackr({ int64AsType: 'number', useRecords: false })
const LEGACY_VERSION = '0.9.83'

type Scope = { characterId: string; chatId: string; operationId: string; dryRun?: boolean }
type FileOperation = { path: string; data: Buffer }
type TransitionRecord = {
    schemaVersion: 1
    direction: 'migrate' | 'rollback'
    operationId: string
    phase: 'prepared' | 'published' | 'completed'
    legacySlots: number
    backups: number
    estimatedBytes: number
    archivePath: string
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function digest(bytes: string | Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
}

function bounded(value: unknown, name: string): asserts value is string {
    if (typeof value !== 'string' || !value.trim() || value.length > 1_024) {
        throw new Error(`Invalid history ${name}`)
    }
}

function legacyChat(value: unknown, scope: Scope, identity: string): Record<string, unknown> {
    if (!record(value) || !Array.isArray(value.message) || typeof value.name !== 'string') {
        throw new Error('Legacy save contains an invalid chat')
    }
    const ids = new Set<string>()
    const messages = value.message.map((message, index) => {
        if (!record(message) || typeof message.data !== 'string' || typeof message.role !== 'string') {
            throw new Error('Legacy save contains an invalid message')
        }
        // Older chats assigned IDs only when sending. Preserve the original bytes
        // separately; deterministic IDs make an interrupted import repeatable.
        const id = typeof message.chatId === 'string' && message.chatId.trim()
            ? message.chatId : `import-${digest(`${scope.chatId}:${identity}:${index}`)}`
        if (ids.has(id)) throw new Error('Legacy save contains duplicate message IDs')
        ids.add(id)
        return { ...message, chatId: id }
    })
    return { ...value, id: scope.chatId, message: messages }
}

export function createStoryHistoryMigration(
    userDataDirectory: string,
    history: StoryHistoryService,
    options: { persistChat?(input: { characterId: string; chatId: string; chat: Record<string, unknown> }): Promise<void> } = {},
) {
    const root = resolve(userDataDirectory)

    function locations(scope: Scope) {
        bounded(scope.characterId, 'character ID')
        bounded(scope.chatId, 'chat ID')
        bounded(scope.operationId, 'operation ID')
        const archivePath = join('risubard', 'history-transitions',
            `id-${Buffer.from(scope.characterId).toString('base64url')}`,
            `id-${Buffer.from(scope.chatId).toString('base64url')}`, digest(scope.operationId))
        return { archivePath, statePath: join(archivePath, 'transition.json') }
    }

    async function safePath(path: string, allowMissing = false): Promise<void> {
        const target = resolve(path)
        if (target !== root && !target.startsWith(root + sep)) throw new Error('History transition path escapes data root')
        let current = root
        const segments = relative(root, target).split(sep).filter(Boolean)
        for (let index = -1; index < segments.length; index++) {
            if (index >= 0) current = join(current, segments[index])
            try {
                const stat = await fs.lstat(current)
                if (stat.isSymbolicLink()) throw new Error('History transition path uses a symbolic link')
                if (index < segments.length - 1 && !stat.isDirectory()) throw new Error('History transition parent is not a directory')
            } catch (error) {
                if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return
                throw error
            }
        }
    }

    async function publish(operations: FileOperation[]): Promise<void> {
        for (const operation of operations) await safePath(join(root, operation.path), true)
        commitTransaction(root, operations)
    }

    async function savedTransition(scope: Scope, direction: TransitionRecord['direction']) {
        const { statePath } = locations(scope)
        await safePath(join(root, statePath), true)
        try {
            const value = JSON.parse(await fs.readFile(join(root, statePath), 'utf8')) as TransitionRecord
            if (value.schemaVersion !== 1 || value.operationId !== scope.operationId || value.direction !== direction) {
                throw new Error('History transition operation does not match')
            }
            return value
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
        }
    }

    async function saveTransition(scope: Scope, value: TransitionRecord) {
        await publish([{ path: locations(scope).statePath, data: Buffer.from(JSON.stringify(value)) }])
    }

    async function requireSpace(bytes: number) {
        const stat = await fs.statfs(root)
        if (stat.bavail * stat.bsize < bytes) {
            throw new Error(`Not enough disk space for history conversion (${bytes} bytes required)`)
        }
    }

    async function verifyFiles(store: string, entries: SavedFileEntry[], verified: Set<string>) {
        for (const entry of entries) {
            if (verified.has(entry.hash)) continue
            const path = join(store, entry.hash.slice(0, 2), entry.hash)
            await safePath(path)
            const bytes = await fs.readFile(path)
            if (bytes.byteLength !== entry.size || digest(bytes) !== entry.hash) {
                throw new Error(`History conversion found a damaged wiki blob: ${entry.hash}`)
            }
            verified.add(entry.hash)
        }
    }

    function report(value: TransitionRecord) {
        return { operationId: value.operationId, legacySlots: value.legacySlots,
            backups: value.backups, estimatedBytes: value.estimatedBytes, archivePath: value.archivePath }
    }

    async function previousExports(scope: Scope) {
        const directory = dirname(join(root, locations(scope).archivePath))
        const mappings = new Map<string, { backupId: string; chatHash: string; wikiFiles: SavedFileEntry[] }>()
        await safePath(directory, true)
        let entries
        try { entries = await fs.readdir(directory, { withFileTypes: true }) }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return mappings
            throw error
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue
            const archive = join(directory, entry.name, 'history-archive.json')
            await safePath(archive, true)
            let value
            try { value = JSON.parse(await fs.readFile(archive, 'utf8')) }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
                throw error
            }
            if (!record(value) || value.schemaVersion !== 1 || value.characterId !== scope.characterId
                || value.chatId !== scope.chatId || !Array.isArray(value.mapping)) {
                throw new Error('Invalid rollback archive')
            }
            for (const item of value.mapping) {
                if (!record(item) || typeof item.saveId !== 'string' || typeof item.backupId !== 'string'
                    || typeof item.chatHash !== 'string' || !Array.isArray(item.wikiFiles)) {
                    throw new Error('Invalid rollback archive mapping')
                }
                mappings.set(item.saveId, { backupId: item.backupId, chatHash: item.chatHash,
                    wikiFiles: parseSavedFiles(JSON.stringify({ schemaVersion: 1, files: item.wikiFiles })) })
            }
        }
        return mappings
    }

    return {
        async migrate(input: Scope & { chat: Record<string, unknown> }) {
            const { archivePath } = locations(input)
            if (!input.dryRun) recoverTransactions(root)
            const previous = await savedTransition(input, 'migrate')
            const before = await history.status(input)
            if (previous?.phase === 'completed') return { state: before, report: report(previous) }
            if (before.mode === 'history') {
                // Publication may have succeeded before the transition receipt.
                if (previous) {
                    const complete: TransitionRecord = { ...previous, phase: 'completed' }
                    if (!input.dryRun) await saveTransition(input, complete)
                    return { state: before, report: report(complete) }
                }
                throw new Error('This chat already uses story history')
            }
            const currentChat = legacyChat(input.chat, input, 'current')
            const slots = await listMemorySaveSlots({ userDataDirectory: root,
                characterId: input.characterId, sourceChatId: input.chatId })
            const exportedSlots = await previousExports(input)
            const source = resolveMemoryWorkspace(root, input.characterId, input.chatId)
            const store = saveStoreDirectory(source.directory)
            // The ordinary slot list hides damaged manifests for UI usability.
            // A migration must not silently omit those saved states.
            const listedIds = new Set(slots.map(slot => slot.saveId))
            const slotPrefix = `id-${Buffer.from('save-slot').toString('base64url')}`
            let directories: Dirent[] = []
            try {
                await safePath(dirname(source.directory), true)
                directories = await fs.readdir(dirname(source.directory), { withFileTypes: true })
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
            for (const entry of directories) {
                if (!entry.name.startsWith(slotPrefix) || /\.(replace|restore)-/.test(entry.name)) continue
                if (entry.isSymbolicLink()) throw new Error('Legacy save uses a symbolic link')
                if (!entry.isDirectory()) continue
                const directory = join(dirname(source.directory), entry.name)
                await safePath(directory)
                const manifestPath = join(directory, 'risubard-save.json')
                await safePath(manifestPath)
                const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
                if (!record(manifest) || typeof manifest.sourceChatId !== 'string'
                    || typeof manifest.saveId !== 'string') throw new Error('Legacy save manifest is damaged')
                if (manifest.sourceChatId === input.chatId && !listedIds.has(manifest.saveId)) {
                    throw new Error(`Legacy save cannot be safely migrated: ${manifest.saveId}`)
                }
            }
            const verified = new Set<string>()
            const imports: Array<{ legacySaveId: string; originalBackupId?: string; chat: Record<string, unknown>; wikiFiles: SavedFileEntry[]; createdAt: string; name: string }> = []
            const originals: FileOperation[] = []
            const legacyWorkspaces: Array<{ directory: string; files: SavedFileEntry[] }> = []
            let estimatedBytes = Buffer.byteLength(JSON.stringify(currentChat)) * 3
            try {
                const currentFiles = await inventoryLegacyWorkspace(source.directory)
                estimatedBytes += currentFiles.reduce((sum, file) => sum + file.size, 0) * 2
                    + Buffer.byteLength(JSON.stringify(currentFiles)) * 3
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
            for (const slot of slots) {
                const workspace = resolveMemoryWorkspace(root, input.characterId, memorySaveWorkspaceId(slot.saveId))
                await safePath(workspace.directory)
                const bytes = await readMemorySaveChat({ userDataDirectory: root, characterId: input.characterId, saveId: slot.saveId })
                const chat = legacyChat(unpacker.unpack(bytes), input, slot.saveId)
                const manifestPath = join(workspace.directory, 'risubard-save.json')
                await safePath(manifestPath)
                const manifestBytes = await fs.readFile(manifestPath)
                const manifest = JSON.parse(manifestBytes.toString('utf8'))
                let wikiFiles: SavedFileEntry[]
                if (manifest.schemaVersion === 2) {
                    const listPath = join(workspace.directory, SAVE_FILES)
                    await safePath(listPath)
                    wikiFiles = parseSavedFiles(await fs.readFile(listPath, 'utf8'))
                    await verifyFiles(store, wikiFiles, verified)
                } else if (manifest.schemaVersion === 1) {
                    wikiFiles = await inventoryLegacyWorkspace(workspace.directory)
                    estimatedBytes += wikiFiles.reduce((sum, file) => sum + file.size, 0) * 2
                    legacyWorkspaces.push({ directory: workspace.directory, files: wikiFiles })
                } else throw new Error('Unsupported legacy save schema')
                const prior = exportedSlots.get(slot.saveId)
                const originalBackupId = prior && prior.chatHash === digest(bytes)
                    && isDeepStrictEqual([...prior.wikiFiles].sort((a, b) => a.path.localeCompare(b.path)),
                        [...wikiFiles].sort((a, b) => a.path.localeCompare(b.path)))
                    ? prior.backupId : undefined
                imports.push({ legacySaveId: slot.saveId, chat, wikiFiles, createdAt: slot.createdAt,
                    name: slot.sourceChatName, ...(originalBackupId ? { originalBackupId } : {}) })
                const key = digest(slot.saveId)
                originals.push({ path: join(archivePath, 'originals', `${key}.bin`), data: bytes },
                    { path: join(archivePath, 'originals', `${key}.json`), data: manifestBytes })
                estimatedBytes += (bytes.byteLength + manifestBytes.byteLength
                    + Buffer.byteLength(JSON.stringify(wikiFiles))) * 3
            }
            const transition: TransitionRecord = { schemaVersion: 1, direction: 'migrate', operationId: input.operationId,
                phase: 'prepared', legacySlots: slots.length, backups: slots.length + 1, estimatedBytes, archivePath }
            if (input.dryRun) return { state: before, report: report(transition) }
            await requireSpace(estimatedBytes)
            await publish([...originals,
                { path: join(archivePath, 'current-chat.bin'), data: packer.pack(input.chat) },
                { path: join(archivePath, 'source-manifest.json'), data: Buffer.from(JSON.stringify({ schemaVersion: 1,
                    legacyVersion: LEGACY_VERSION, characterId: input.characterId, chatId: input.chatId,
                    slots: slots.map((slot, index) => ({ ...slot, archiveKey: digest(slot.saveId),
                        chatHash: digest(originals[index * 2].data), wikiFiles: imports[index].wikiFiles })) })) },
                { path: locations(input).statePath, data: Buffer.from(JSON.stringify(transition)) }])
            for (const workspace of legacyWorkspaces) {
                const copied = (await snapshotWorkspaceToStore(fs, workspace.directory, store))
                    .filter(file => file.path !== 'chat.bin' && file.path !== 'risubard-save.json')
                    .sort((a, b) => a.path.localeCompare(b.path))
                if (!isDeepStrictEqual(copied, workspace.files)) {
                    throw new Error('Legacy wiki changed during history conversion')
                }
                await verifyFiles(store, copied, verified)
            }
            await options.persistChat?.({ characterId: input.characterId, chatId: input.chatId, chat: currentChat })
            const state = await history.importLegacy({ characterId: input.characterId, chatId: input.chatId,
                imports, currentChat, operationId: input.operationId })
            const complete: TransitionRecord = { ...transition, phase: 'completed' }
            await saveTransition(input, complete)
            return { state, report: report(complete) }
        },

        async rollback(input: Scope & { chat?: Record<string, unknown> }) {
            const { archivePath } = locations(input)
            if (!input.dryRun) recoverTransactions(root)
            const previous = await savedTransition(input, 'rollback')
            const before = await history.status(input)
            if (previous?.phase === 'completed') return { state: before, report: report(previous) }
            if (before.mode !== 'history') {
                if (previous?.phase === 'published') {
                    const complete: TransitionRecord = { ...previous, phase: 'completed' }
                    if (!input.dryRun) await saveTransition(input, complete)
                    return { state: before, report: report(complete) }
                }
                throw new Error('This chat does not use story history')
            }
            if (input.chat && !input.dryRun) {
                const chat = legacyChat(input.chat, input, 'current')
                const { message, ...state } = chat
                const messages = message as Array<Record<string, unknown>>
                await history.capture({ characterId: input.characterId, chatId: input.chatId,
                    operationId: `${input.operationId}:working`, kind: 'working', delta: {
                        baseSnapshotId: before.workingSnapshotId, order: messages.map(item => item.chatId as string),
                        messages: messages.map(value => ({ id: value.chatId as string, value })), state,
                    } })
            }
            const exported = await history.exportHistory(input)
            const source = resolveMemoryWorkspace(root, input.characterId, input.chatId)
            const store = saveStoreDirectory(source.directory)
            const verified = new Set<string>()
            const operations: FileOperation[] = []
            const mapping: Array<{ backupId: string; saveId: string; chatHash: string; wikiFiles: SavedFileEntry[] }> = []
            let estimatedBytes = 0
            for (const item of exported.backups) {
                await verifyFiles(store, item.wikiFiles, verified)
                const saveId = `history-${digest(`${input.chatId}:${input.operationId}:${item.backup.id}`)}`
                const directory = resolveMemoryWorkspace(root, input.characterId, memorySaveWorkspaceId(saveId)).directory
                await safePath(directory, true)
                const bytes = packer.pack(item.chat)
                if (!isDeepStrictEqual(unpacker.unpack(bytes), item.chat)) throw new Error('Legacy chat encoding is not lossless')
                const name = String(item.backup.name || item.chat.name || 'History').slice(0, 512)
                const messages = Array.isArray(item.chat.message) ? item.chat.message as Array<Record<string, unknown>> : []
                const latest = [...messages].reverse().find(message => !message.isComment && !message.disabled)
                const manifest = { schemaVersion: 2, saveId, sourceChatId: input.chatId, sourceChatName: name,
                    createdAt: item.backup.createdAt,
                    turnCount: messages.filter(message => message.role === 'char' && !message.isComment && !message.disabled).length,
                    ...(typeof latest?.chatId === 'string' ? { latestMessageId: latest.chatId } : {}) }
                const files = [
                    { path: join(directory, 'chat.bin'), data: bytes },
                    { path: join(directory, 'risubard-save.json'), data: Buffer.from(JSON.stringify(manifest)) },
                    { path: join(directory, SAVE_FILES), data: Buffer.from(serializeSavedFiles(item.wikiFiles)) },
                ]
                for (const file of files) {
                    try {
                        const existing = await fs.readFile(file.path)
                        if (!existing.equals(file.data)) throw new Error('Rollback destination already contains different data')
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                    }
                    operations.push({ path: relative(root, file.path), data: file.data })
                    estimatedBytes += file.data.byteLength * 2
                }
                mapping.push({ backupId: item.backup.id, saveId, chatHash: digest(bytes), wikiFiles: item.wikiFiles })
            }
            await verifyFiles(store, exported.currentWikiFiles, verified)
            const archive = Buffer.from(JSON.stringify({ schemaVersion: 1, legacyVersion: LEGACY_VERSION,
                characterId: input.characterId, chatId: input.chatId, state: exported.state, mapping }))
            estimatedBytes += archive.byteLength * 2
            const transition: TransitionRecord = { schemaVersion: 1, direction: 'rollback', operationId: input.operationId,
                phase: 'prepared', legacySlots: mapping.length, backups: exported.backups.length, estimatedBytes, archivePath }
            if (input.dryRun) return { state: exported.state, report: report(transition) }
            await requireSpace(estimatedBytes)
            await saveTransition(input, transition)
            operations.push({ path: join(archivePath, 'history-archive.json'), data: archive },
                { path: join(archivePath, 'current-chat.bin'), data: packer.pack(exported.currentChat) },
                { path: join(archivePath, 'current-wiki.json'), data: Buffer.from(serializeSavedFiles(exported.currentWikiFiles)) })
            await publish(operations)
            // Verify through the actual legacy reader before switching writers.
            for (const entry of mapping) {
                const bytes = await readMemorySaveChat({ userDataDirectory: root,
                    characterId: input.characterId, saveId: entry.saveId })
                if (digest(bytes) !== entry.chatHash) throw new Error('Rollback slot verification failed')
            }
            await options.persistChat?.({ characterId: input.characterId, chatId: input.chatId, chat: exported.currentChat })
            await saveTransition(input, { ...transition, phase: 'published' })
            const state = await history.deactivate({ characterId: input.characterId, chatId: input.chatId, operationId: input.operationId })
            const complete: TransitionRecord = { ...transition, phase: 'completed' }
            await saveTransition(input, complete)
            return { state, report: report(complete), chat: exported.currentChat }
        },
    }

    async function inventoryLegacyWorkspace(directory: string): Promise<SavedFileEntry[]> {
        const files: SavedFileEntry[] = []
        const walk = async (current: string, prefix: string) => {
            await safePath(current)
            for (const entry of await fs.readdir(current, { withFileTypes: true })) {
                if (entry.name === '.risubard-snapshots' || entry.name === '.risubard-recovery') continue
                if (entry.isSymbolicLink()) throw new Error('Legacy wiki contains a symbolic link')
                const path = join(current, entry.name)
                const key = prefix + entry.name
                if (entry.isDirectory()) await walk(path, key + '/')
                else if (entry.isFile()) {
                    if (key === 'chat.bin' || key === 'risubard-save.json') continue
                    const bytes = await fs.readFile(path)
                    files.push({ path: key, hash: digest(bytes), size: bytes.byteLength })
                } else throw new Error('Legacy wiki contains a non-regular file')
            }
        }
        await walk(directory, '')
        return files.sort((a, b) => a.path.localeCompare(b.path))
    }
}
