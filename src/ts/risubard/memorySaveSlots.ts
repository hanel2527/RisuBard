import type { Chat, Message } from '../storage/database.svelte'
import { Packr, Unpackr } from 'msgpackr/index-no-eval'
import { invokeBrowserFetch } from './browserFetch'
import { rebindPainterChatScope } from '../bardPainter/chatScope'

const chatPacker = new Packr({ useRecords: false })
const chatUnpacker = new Unpackr({
    int64AsType: 'number',
    useRecords: false,
})
const MEMORY_SAVE_REQUEST_TIMEOUT_MS = 10 * 60_000

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

export interface MemorySavePreviewMessage {
    role: 'user' | 'char'
    data: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedId(value: unknown, label: string): string {
    if (typeof value !== 'string'
        || value.trim().length === 0
        || value.length > 1_024) {
        throw new Error(`${label} must be a non-empty bounded ID`)
    }
    return value
}

function encodeBase64Url(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '')
}

function parseEvent(value: unknown): MemorySaveEventPreview {
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

function parseSummary(value: unknown): MemorySaveSlotSummary {
    if (!isRecord(value)) throw new Error('Invalid memory save summary')
    const hasEvent = value.latestEvent !== undefined
    const hasLatestMessageId = value.latestMessageId !== undefined
    const keys = [
        'saveId', 'sourceChatId', 'sourceChatName', 'createdAt', 'turnCount',
        ...(hasLatestMessageId ? ['latestMessageId'] : []),
        ...(hasEvent ? ['latestEvent'] : []),
    ]
    if (Object.keys(value).length !== keys.length
        || !keys.every((key) => Object.hasOwn(value, key))
        || typeof value.saveId !== 'string'
        || typeof value.sourceChatId !== 'string'
        || typeof value.sourceChatName !== 'string'
        || value.sourceChatName.length > 512
        || typeof value.createdAt !== 'string'
        || !Number.isFinite(Date.parse(value.createdAt))
        || !Number.isSafeInteger(value.turnCount)
        || (value.turnCount as number) < 0) {
        throw new Error('Invalid memory save summary')
    }
    return {
        saveId: boundedId(value.saveId, 'Saved slot ID'),
        sourceChatId: boundedId(value.sourceChatId, 'Saved source chat ID'),
        sourceChatName: value.sourceChatName,
        createdAt: value.createdAt,
        turnCount: value.turnCount as number,
        ...(hasLatestMessageId ? {
            latestMessageId: boundedId(
                value.latestMessageId as string,
                'Latest saved message ID'
            ),
        } : {}),
        ...(hasEvent ? { latestEvent: parseEvent(value.latestEvent) } : {}),
    }
}

function projectEndpointSummary(
    value: unknown,
    extraFields: readonly string[]
): MemorySaveSlotSummary {
    if (!isRecord(value)) throw new Error('Invalid memory save summary')
    const summaryFields = [
        'saveId', 'sourceChatId', 'sourceChatName', 'createdAt', 'turnCount',
        'latestMessageId', 'latestEvent',
    ]
    const allowedFields = Object.fromEntries(
        [...summaryFields, ...extraFields].map((key) => [key, true])
    )
    if (Object.keys(value).some((key) => !Object.hasOwn(allowedFields, key))) {
        throw new Error('Invalid memory save summary')
    }
    return parseSummary(Object.fromEntries(
        Object.entries(value).filter(([key]) => summaryFields.includes(key))
    ))
}

function validateEndpointIdFields(
    value: Record<string, unknown>,
    fields: readonly string[]
): void {
    for (const field of fields) {
        if (Object.hasOwn(value, field)) {
            const id = value[field]
            if (typeof id !== 'string') throw new Error(`Invalid saved ${field}`)
            boundedId(id, `Saved ${field}`)
        }
    }
}

function parseCreateSaveResponse(value: unknown): MemorySaveSlotSummary {
    if (!isRecord(value)) throw new Error('Invalid memory save summary')
    validateEndpointIdFields(value, [
        'wikiCommitId', 'wikiRefId', 'capturedCommitId',
    ])
    return projectEndpointSummary(value, [
        'wikiCommitId', 'wikiRefId', 'capturedCommitId',
    ])
}

function parseReferenceAutosaveResponse(
    value: unknown
): MemorySaveSlotSummary {
    if (!isRecord(value)
        || value.schemaVersion !== 1
        || value.mode !== 'commit-reference'
        || typeof value.chatStateRef !== 'string') {
        throw new Error('Invalid memory reference save summary')
    }
    validateEndpointIdFields(value, [
        'chatStateRef', 'wikiCommitId', 'branchId', 'wikiRevision',
        'chatHash', 'wikiRefId', 'capturedCommitId',
    ])
    return projectEndpointSummary(value, [
        'schemaVersion', 'mode', 'chatStateRef', 'wikiCommitId', 'branchId',
        'wikiRevision', 'chatHash', 'wikiRefId', 'capturedCommitId',
    ])
}

function parseListAllSummary(
    value: unknown
): MemorySaveSlotSummary & { saveFormat: 'v1-snapshot' | 'commit-reference' } {
    if (!isRecord(value)
        || (value.saveFormat !== 'v1-snapshot'
            && value.saveFormat !== 'commit-reference')) {
        throw new Error('Invalid memory save format')
    }
    return {
        ...projectEndpointSummary(value, ['saveFormat']),
        saveFormat: value.saveFormat,
    }
}

async function failureDetail(response: Response): Promise<string> {
    const value: unknown = await response.json().catch(() => undefined)
    return isRecord(value)
        && typeof value.error === 'string'
        && value.error.length <= 1_000
        ? `: ${value.error}`
        : ''
}

export function countChatTurns(messages: readonly Message[]): number {
    return messages.filter((message) =>
        message.role === 'char'
        && !message.isComment
        && !message.disabled
    ).length
}

export function latestChatMessageId(
    messages: readonly Message[]
): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message.isComment || message.disabled) continue
        return typeof message.chatId === 'string' && message.chatId.trim()
            ? message.chatId
            : undefined
    }
    return undefined
}

export function shouldConfirmMemorySaveLoad(
    currentLatestMessageId: string | undefined,
    slots: readonly MemorySaveSlotSummary[]
): boolean {
    const newest = [...slots].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
        || right.saveId.localeCompare(left.saveId)
    )[0]
    return !currentLatestMessageId
        || !newest?.latestMessageId
        || newest.latestMessageId !== currentLatestMessageId
}

export function encodeMemorySaveChat(chat: Chat): Uint8Array {
    return chatPacker.pack(chat)
}

export function decodeMemorySaveChat(bytes: Uint8Array): unknown {
    return chatUnpacker.unpack(bytes)
}

function applyMemorySavePromptSettings(chat: Chat, currentChat?: Chat): void {
    // Save slots rewind story state, not the current sidebar preferences.
    for (const key of [
        'bindedPersona', 'bindedBotPreset', 'usePromptPresetParams',
        'useModelPreset', 'modelBinding', 'useLocallySetGlobalVariables',
        'togglePresetBaseline',
    ] as const) {
        delete chat[key]
        if (currentChat?.[key] !== undefined) {
            Object.assign(chat, { [key]: currentChat[key] })
        }
    }
    delete chat.savedToggleValues
    const legacyToggles = currentChat?.GLGlobalVariables === undefined
        ? currentChat?.savedToggleValues
        : undefined
    const currentVariables = currentChat?.GLGlobalVariables ?? legacyToggles ?? {}
    const variables = Object.fromEntries([
        ...Object.entries(chat.GLGlobalVariables ?? {})
            .filter(([key]) => !key.startsWith('toggle_')),
        ...Object.entries(currentVariables)
            .filter(([key]) => key.startsWith('toggle_')),
    ])
    if (Object.keys(variables).length > 0) chat.GLGlobalVariables = variables
    else delete chat.GLGlobalVariables
    // Normalize only the current chat's old pin format; never migrate saved settings.
    if (legacyToggles) chat.useLocallySetGlobalVariables = true
}

function requestBody(bytes: Uint8Array): ArrayBuffer {
    return Uint8Array.from(bytes).buffer
}

async function withMemorySaveTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
        controller.abort(new DOMException(
            'Memory save request timed out',
            'TimeoutError'
        ))
    }, MEMORY_SAVE_REQUEST_TIMEOUT_MS)
    const running = operation(controller.signal)
    try {
        return await new Promise<T>((resolve, reject) => {
            const onAbort = () => reject(controller.signal.reason)
            controller.signal.addEventListener('abort', onAbort, { once: true })
            void running.then(resolve, reject).finally(() => {
                controller.signal.removeEventListener('abort', onAbort)
            })
        })
    }
    finally {
        clearTimeout(timeout)
    }
}

export async function createMemorySaveSlot(input: {
    characterId: string
    chat: Chat
    saveId: string
    overwrite?: boolean
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<MemorySaveSlotSummary> {
    const characterId = boundedId(input.characterId, 'Character ID')
    const sourceChatId = boundedId(input.chat.id ?? '', 'Chat ID')
    const saveId = boundedId(input.saveId, 'Save slot ID')
    if (typeof input.chat.name !== 'string'
        || input.chat.name.trim().length === 0
        || input.chat.name.length > 512) {
        throw new Error('Chat name must be a non-empty bounded string')
    }
    const snapshot = structuredClone(input.chat)
    applyMemorySavePromptSettings(snapshot)
    delete snapshot._placeholder
    snapshot.isStreaming = false
    delete snapshot.activeStreamingDisplayOptimizationMode
    const latestMessageId = latestChatMessageId(snapshot.message)
    const response = await withMemorySaveTimeout(async (signal) =>
        invokeBrowserFetch(
            input.fetchImpl,
            '/api/risubard/memory/save-slot',
            {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'content-type': 'application/octet-stream',
                    'risu-auth': await input.createAuth(),
                    'x-risubard-character-id': characterId,
                    'x-risubard-source-chat-id': sourceChatId,
                    'x-risubard-save-id': saveId,
                    ...(input.overwrite
                        ? { 'x-risubard-save-overwrite': 'true' }
                        : {}),
                    'x-risubard-chat-name': encodeBase64Url(snapshot.name),
                    'x-risubard-turn-count': String(
                        countChatTurns(snapshot.message)
                    ),
                    ...(latestMessageId ? {
                        'x-risubard-latest-message-id': latestMessageId,
                    } : {}),
                },
                body: requestBody(encodeMemorySaveChat(snapshot)),
                signal,
            }
        )
    )
    if (!response.ok) {
        throw new Error(
            `Memory save failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    return parseCreateSaveResponse(await response.json())
}

export async function listMemorySaveSlots(input: {
    characterId: string
    sourceChatId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<MemorySaveSlotSummary[]> {
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/save-slot/list',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify({
                characterId: boundedId(input.characterId, 'Character ID'),
                sourceChatId: boundedId(input.sourceChatId, 'Chat ID'),
            }),
        }
    )
    if (!response.ok) {
        throw new Error(
            `Memory save list failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    const value: unknown = await response.json()
    if (!Array.isArray(value) || value.length > 10_000) {
        throw new Error('Invalid memory save list')
    }
    return value.map(parseSummary)
}

export async function renameMemorySaveSlot(input: {
    characterId: string
    saveId: string
    name: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<MemorySaveSlotSummary> {
    const name = input.name.trim()
    if (!name || name.length > 512) {
        throw new Error('Saved file name must be a non-empty bounded string')
    }
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/save-slot/rename',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify({
                characterId: boundedId(input.characterId, 'Character ID'),
                saveId: boundedId(input.saveId, 'Saved file ID'),
                name,
            }),
        }
    )
    if (!response.ok) {
        throw new Error(
            `Memory save rename failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    return parseSummary(await response.json())
}

export async function deleteMemorySaveSlot(input: {
    characterId: string
    saveId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<void> {
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/save-slot/delete',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify({
                characterId: boundedId(input.characterId, 'Character ID'),
                saveId: boundedId(input.saveId, 'Saved file ID'),
            }),
        }
    )
    if (!response.ok) {
        throw new Error(
            `Memory save deletion failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
}

export async function previewMemorySaveSlot(input: {
    characterId: string
    saveId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<MemorySavePreviewMessage[]> {
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/save-slot/preview',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify({
                characterId: boundedId(input.characterId, 'Character ID'),
                saveId: boundedId(input.saveId, 'Saved file ID'),
            }),
        }
    )
    if (!response.ok) {
        throw new Error(
            `Memory save preview failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    const decoded = decodeMemorySaveChat(
        new Uint8Array(await response.arrayBuffer())
    )
    if (!isRecord(decoded) || !Array.isArray(decoded.message)) {
        throw new Error('Memory save preview returned an invalid chat snapshot')
    }
    const visibleMessages = decoded.message
        .filter((message): message is Record<string, unknown> =>
            isRecord(message)
            && (message.role === 'user' || message.role === 'char')
            && typeof message.data === 'string'
            && !message.isComment
            && !message.disabled
        )
    const latestByRole = new Map<'user' | 'char', {
        index: number
        role: 'user' | 'char'
        data: string
    }>()
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
        const message = visibleMessages[index]
        const role = message.role as 'user' | 'char'
        if (!latestByRole.has(role)) {
            latestByRole.set(role, { index, role, data: message.data as string })
        }
        if (latestByRole.size === 2) break
    }
    return [...latestByRole.values()]
        .sort((left, right) => left.index - right.index)
        .map(({ role, data }) => ({ role, data }))
}

export async function prepareMemorySaveLoad(input: {
    characterId: string
    saveId: string
    currentChat: Chat
    destinationChatId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<{ chat: Chat; forkToken: string }> {
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/save-slot/load',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify({
                characterId: boundedId(input.characterId, 'Character ID'),
                saveId: boundedId(input.saveId, 'Save slot ID'),
                destinationChatId: boundedId(
                    input.destinationChatId, 'Destination chat ID'
                ),
            }),
        }
    )
    if (!response.ok) {
        throw new Error(
            `Memory save load failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    const forkToken = response.headers.get('x-risubard-fork-token')
    if (!forkToken || forkToken.length > 1_024) {
        throw new Error('Memory save load response is missing its fork token')
    }
    const decoded: unknown = decodeMemorySaveChat(
        new Uint8Array(await response.arrayBuffer())
    )
    if (!isRecord(decoded)
        || !Array.isArray(decoded.message)
        || typeof decoded.name !== 'string') {
        throw new Error('Memory save load returned an invalid chat snapshot')
    }
    const chat = decoded as unknown as Chat
    applyMemorySavePromptSettings(chat, input.currentChat)
    if (typeof chat.note !== 'string') chat.note = ''
    if (!Array.isArray(chat.localLore)) chat.localLore = []
    // The caller assigns the destination chat ID after preparation; bind painter
    // scenes to that same destination without changing the decoded snapshot's ID.
    rebindPainterChatScope({ id: input.destinationChatId, bardPainter: chat.bardPainter }, input.characterId)
    return { chat, forkToken }
}

export interface MemoryReferenceSaveSummary extends MemorySaveSlotSummary {
    saveFormat: 'commit-reference'
}

/**
 * Reference autosave: records the chat and the wiki commit it belongs to
 * without copying the wiki tree. The server deduplicates the chat bytes by
 * hash, so an unchanged chat adds no storage.
 */
export async function writeReferenceAutosave(input: {
    characterId: string
    chat: Chat
    saveId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<MemorySaveSlotSummary> {
    const characterId = boundedId(input.characterId, 'Character ID')
    const sourceChatId = boundedId(input.chat.id ?? '', 'Chat ID')
    const saveId = boundedId(input.saveId, 'Save slot ID')
    if (typeof input.chat.name !== 'string'
        || input.chat.name.trim().length === 0
        || input.chat.name.length > 512) {
        throw new Error('Chat name must be a non-empty bounded string')
    }
    const snapshot = structuredClone(input.chat)
    applyMemorySavePromptSettings(snapshot)
    delete snapshot._placeholder
    snapshot.isStreaming = false
    delete snapshot.activeStreamingDisplayOptimizationMode
    const latestMessageId = latestChatMessageId(snapshot.message)
    const response = await withMemorySaveTimeout(async (signal) =>
        invokeBrowserFetch(
            input.fetchImpl,
            '/api/risubard/memory/save-slot/reference',
            {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'content-type': 'application/octet-stream',
                    'risu-auth': await input.createAuth(),
                    'x-risubard-character-id': characterId,
                    'x-risubard-source-chat-id': sourceChatId,
                    'x-risubard-save-id': saveId,
                    'x-risubard-chat-name': encodeBase64Url(snapshot.name),
                    'x-risubard-turn-count': String(
                        countChatTurns(snapshot.message)
                    ),
                    ...(latestMessageId ? {
                        'x-risubard-latest-message-id': latestMessageId,
                    } : {}),
                },
                body: requestBody(encodeMemorySaveChat(snapshot)),
                signal,
            }
        )
    )
    if (!response.ok) {
        throw new Error(
            `Reference autosave failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    return parseReferenceAutosaveResponse(await response.json())
}

/**
 * Loads a reference save. The wiki is materialized in the destination chat from
 * the pinned commit rather than copied, so both the chat and the wiki land at
 * the recorded point in the story.
 */
export async function prepareReferenceSaveLoad(input: {
    characterId: string
    saveId: string
    destinationChatId: string
    currentChat: Chat
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<{
    chat: Chat
    wikiCommitId?: string
    sourceChatId: string
} | null> {
    const response = await withMemorySaveTimeout(async (signal) =>
        invokeBrowserFetch(
            input.fetchImpl,
            '/api/risubard/memory/save-slot/reference/load',
            {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'content-type': 'application/json',
                    'risu-auth': await input.createAuth(),
                },
                body: JSON.stringify({
                    characterId: boundedId(input.characterId, 'Character ID'),
                    saveId: boundedId(input.saveId, 'Save slot ID'),
                    destinationChatId: boundedId(
                        input.destinationChatId, 'Destination chat ID'
                    ),
                }),
                signal,
            }
        )
    )
    // No reference save for this slot: the caller falls back to the v1 format.
    if (response.status === 404) return null
    if (!response.ok) {
        throw new Error(
            `Reference save load failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    const value: unknown = await response.json()
    if (!isRecord(value)
        || typeof value.chatBase64 !== 'string'
        || value.chatBase64.length === 0
        || !isRecord(value.save)
        || typeof value.save.sourceChatId !== 'string') {
        throw new Error('Reference save load returned an invalid response')
    }
    const bytes = Uint8Array.from(
        Buffer.from(value.chatBase64, 'base64')
    )
    const decoded: unknown = decodeMemorySaveChat(bytes)
    if (!isRecord(decoded)
        || !Array.isArray(decoded.message)
        || typeof decoded.name !== 'string') {
        throw new Error('Reference save load returned an invalid chat snapshot')
    }
    const chat = decoded as unknown as Chat
    applyMemorySavePromptSettings(chat, input.currentChat)
    if (typeof chat.note !== 'string') chat.note = ''
    if (!Array.isArray(chat.localLore)) chat.localLore = []
    rebindPainterChatScope(
        { id: input.destinationChatId, bardPainter: chat.bardPainter },
        input.characterId
    )
    return {
        chat,
        sourceChatId: boundedId(value.save.sourceChatId, 'Source chat ID'),
        ...(typeof value.wikiCommitId === 'string'
            ? { wikiCommitId: value.wikiCommitId } : {}),
    }
}

/** Lists v1 snapshots and reference saves together for the save dialog. */
export async function listAllMemorySaveSlots(input: {
    characterId: string
    sourceChatId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<Array<
    MemorySaveSlotSummary & {
        saveFormat: 'v1-snapshot' | 'commit-reference'
    }
>> {
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/save-slot/list-all',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify({
                characterId: boundedId(input.characterId, 'Character ID'),
                sourceChatId: boundedId(input.sourceChatId, 'Chat ID'),
            }),
        }
    )
    if (!response.ok) {
        throw new Error(
            `Memory save list failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    const value: unknown = await response.json()
    if (!Array.isArray(value) || value.length > 10_000) {
        throw new Error('Invalid memory save list')
    }
    return value.map(parseListAllSummary)
}

/**
 * Converts a reference save into a v1-compatible save. Reference saves keep the
 * wiki as a commit pointer, which builds predating the version store cannot
 * read, so handing a save to an older build needs this explicit conversion.
 */
export async function exportReferenceSaveCompat(input: {
    characterId: string
    saveId: string
    targetSaveId: string
    sourceChatName?: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<MemorySaveSlotSummary> {
    const response = await withMemorySaveTimeout(async (signal) =>
        invokeBrowserFetch(
            input.fetchImpl,
            '/api/risubard/memory/save-slot/reference/export',
            {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'content-type': 'application/json',
                    'risu-auth': await input.createAuth(),
                },
                body: JSON.stringify({
                    characterId: boundedId(input.characterId, 'Character ID'),
                    saveId: boundedId(input.saveId, 'Save slot ID'),
                    targetSaveId: boundedId(
                        input.targetSaveId, 'Target save slot ID'
                    ),
                    ...(input.sourceChatName
                        ? { sourceChatName: input.sourceChatName } : {}),
                }),
                signal,
            }
        )
    )
    if (!response.ok) {
        throw new Error(
            `Reference save export failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    return parseSummary(await response.json())
}
