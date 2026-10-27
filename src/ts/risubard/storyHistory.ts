import { v4 } from 'uuid'
import type { Chat } from '../storage/database.svelte'
import { forageStorage } from '../globalApi.svelte'
import { applyMemorySavePromptSettings } from './memorySavePromptSettings'
import { rebindPainterChatScope } from '../bardPainter/chatScope'
import { announceRisuBardMemoryUpdated, RISUBARD_MEMORY_UPDATED_EVENT, type RisuBardMemoryUpdatedDetail } from './memoryEvents'
import { isNodeServer } from '../platform'
import type { StoryBeginWikiInput, StoryCaptureInput, StoryFinishWikiInput, StoryHistoryState, StoryPendingWiki } from './storyHistoryTypes'

export type { StoryHistoryState, StoryBackupSummary, StoryPendingWiki } from './storyHistoryTypes'
export interface StoryHistoryChange { characterId: string; chatId: string; state?: StoryHistoryState; error?: string }
export const storyHistoryEvents = new EventTarget()
const lanes = new Map<string, Promise<unknown>>()
interface Baseline { snapshotId: string | null; messages: Map<string, string>; order: string; state: string }
const baselines = new Map<string, Baseline>()
const transitionOperations = new Map<string, string>()
const activeWikiOperations = new Set<string>()
const identity = (characterId: string, chatId: string) => JSON.stringify([characterId, chatId])
function publish(change: StoryHistoryChange) {
    storyHistoryEvents.dispatchEvent(new CustomEvent('change', { detail: change }))
}
export function subscribeStoryHistory(listener: (change: StoryHistoryChange) => void): () => void {
    const handler = (event: Event) => listener((event as CustomEvent<StoryHistoryChange>).detail)
    storyHistoryEvents.addEventListener('change', handler)
    return () => storyHistoryEvents.removeEventListener('change', handler)
}
if (typeof window !== 'undefined') {
    window.addEventListener(RISUBARD_MEMORY_UPDATED_EVENT, event => {
        const detail = (event as CustomEvent<RisuBardMemoryUpdatedDetail>).detail
        if (detail?.characterId && detail.chatId) void getStoryHistory(detail.characterId, detail.chatId).catch(() => {})
    })
}
function serial<T>(characterId: string, chatId: string, operation: () => Promise<T>): Promise<T> {
    const key = identity(characterId, chatId)
    const job = (lanes.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
    lanes.set(key, job)
    void job.finally(() => { if (lanes.get(key) === job) lanes.delete(key) }).catch(() => {})
    return job
}
async function request<T>(action: string, input: { characterId: string; chatId: string; [key: string]: unknown }): Promise<T> {
    try {
        await forageStorage.Init()
        const response = await forageStorage.realStorage.requestStoryHistory(action, input)
        const result = await response.json()
        if (!response.ok) throw new Error(result?.error ?? `Story history ${action} failed (${response.status})`)
        return result as T
    } catch (error) {
        publish({ characterId: input.characterId, chatId: input.chatId, error: error instanceof Error ? error.message : String(error) })
        throw error
    }
}
export async function getStoryHistory(characterId: string, chatId: string, chat?: Chat): Promise<StoryHistoryState> {
    if (chat?.risuBardInitializeHistory && !chat._placeholder && !chat.isStreaming) {
        return captureStoryChat(characterId, chat)
    }
    if (!isNodeServer) return {
        mode: 'legacy', revision: 0, epoch: 0, headId: null, branchId: null,
        wikiCommitId: null, workingSnapshotId: null, quickSaveId: null, anchorMessageId: null,
        bindings: {}, pendingWiki: null, pendingCheckout: null, branches: [], backups: [],
    }
    const state = await request<StoryHistoryState>('status', { characterId, chatId })
    publish({ characterId, chatId, state })
    return state
}
function chatState(chat: Chat): Record<string, unknown> {
    const { message: _messages, ...rest } = chat
    const state = rest as unknown as Chat
    applyMemorySavePromptSettings(state)
    delete state._placeholder
    delete state.risuBardWikiReboot
    delete state.risuBardInitializeHistory
    delete state.activeStreamingDisplayOptimizationMode
    state.isStreaming = false
    return state as unknown as Record<string, unknown>
}
/** Existing legacy chats stay unchanged; new chats may opt into VCS at creation. */
export function captureStoryChat(characterId: string, chat: Chat, kind: StoryCaptureInput['kind'] = 'working', options: { anchorMessageId?: string | null; operationId?: string } = {}): Promise<StoryHistoryState> {
    chat.id ||= v4()
    for (const message of chat.message) message.chatId ||= v4()
    const chatId = chat.id
    // Freeze at the persistence/completion boundary, not after waiting for a lane.
    const order = chat.message.map(message => message.chatId!)
    const encoded = chat.message.map(message => JSON.stringify(message))
    const stateValue = chatState(chat)
    const encodedState = JSON.stringify(stateValue)
    return serial(characterId, chatId, async () => {
        let current = await getStoryHistory(characterId, chatId)
        if (current.mode === 'legacy') {
            if (!isNodeServer || !chat.risuBardInitializeHistory) return current
            const initialized = await request<StoryTransitionResult>('migrate', {
                characterId, chatId, operationId: `new-chat:${chatId}`,
                chat: { ...stateValue, message: encoded.map(value => JSON.parse(value)) },
            })
            current = initialized.state
        }
        delete chat.risuBardInitializeHistory
        const key = identity(characterId, chatId)
        const cached = baselines.get(key)
        const baseline = cached?.snapshotId === current.workingSnapshotId ? cached : undefined
        const encodedOrder = JSON.stringify(order)
        const changed = order.flatMap((id, index) => baseline?.messages.get(id) === encoded[index]
            ? [] : [{ id, value: JSON.parse(encoded[index]) as Record<string, unknown> }])
        if (kind !== 'manual' && baseline && changed.length === 0 && baseline.order === encodedOrder && baseline.state === encodedState) return current
        const next = await request<StoryHistoryState>('capture', {
            characterId, chatId, operationId: options.operationId ?? v4(), expectedRevision: current.revision, kind,
            delta: { baseSnapshotId: current.workingSnapshotId, order, messages: changed, state: JSON.parse(encodedState) },
            ...(options.anchorMessageId !== undefined ? { anchorMessageId: options.anchorMessageId } : {}),
        })
        baselines.set(key, { snapshotId: next.workingSnapshotId, messages: new Map(order.map((id, index) => [id, encoded[index]])), order: encodedOrder, state: encodedState })
        publish({ characterId, chatId, state: next })
        return next
    })
}
export function beginStoryWiki(input: StoryBeginWikiInput): Promise<StoryHistoryState> {
    return serial(input.characterId, input.chatId, async () => {
        const state = await request<StoryHistoryState>('begin-wiki', { ...input })
        if (state.pendingWiki?.operationId === input.operationId) activeWikiOperations.add(input.operationId)
        publish({ ...input, state })
        return state
    })
}
export function finishStoryWiki(input: StoryFinishWikiInput): Promise<StoryHistoryState> {
    return serial(input.characterId, input.chatId, async () => {
        try {
            const state = await request<StoryHistoryState>('finish-wiki', { ...input })
            publish({ ...input, state })
            return state
        } finally {
            activeWikiOperations.delete(input.operationId)
        }
    })
}
export interface StoryBackupPreview { chat: Chat; documents: Array<{ path: string; content?: string }>; backup?: unknown }
export async function previewStoryBackup(characterId: string, chatId: string, backupId: string, sourceOperationId?: string): Promise<StoryBackupPreview> {
    const result = await request<{ chat: Chat; backup?: unknown; wikiFiles?: Array<{ path: string; content?: string }>; documents?: Array<{ path: string; content?: string }> }>('preview', { characterId, chatId, backupId, ...(sourceOperationId ? { sourceOperationId } : {}) })
    return { chat: result.chat, documents: result.documents ?? result.wikiFiles ?? [], backup: result.backup }
}
export async function loadStoryBackup(characterId: string, currentChat: Chat, backupId: string, asNewChat = false): Promise<Chat> {
    const chatId = currentChat.id!
    await captureStoryChat(characterId, currentChat)
    return serial(characterId, chatId, async () => {
        const current = await getStoryHistory(characterId, chatId)
        const result = await request<{ chat: Chat; state: StoryHistoryState; destinationChatId: string }>('checkout', {
            characterId, chatId, backupId, asNewChat, destinationChatId: asNewChat ? v4() : chatId, expectedRevision: current.revision,
        })
        const chat = result.chat
        chat.id = result.destinationChatId
        applyMemorySavePromptSettings(chat, currentChat)
        delete chat.risuBardWikiReboot
        chat.isStreaming = false
        delete chat.activeStreamingDisplayOptimizationMode
        if (typeof chat.note !== 'string') chat.note = ''
        if (!Array.isArray(chat.localLore)) chat.localLore = []
        rebindPainterChatScope(chat, characterId)
        const order = chat.message.map(message => message.chatId!)
        baselines.set(identity(characterId, chat.id!), {
            snapshotId: result.state.workingSnapshotId,
            messages: new Map(chat.message.map(message => [message.chatId!, JSON.stringify(message)])),
            order: JSON.stringify(order), state: JSON.stringify(chatState(chat)),
        })
        publish({ characterId, chatId: chat.id!, state: result.state })
        announceRisuBardMemoryUpdated({ characterId, chatId: chat.id! })
        return chat
    })
}
export function renameStoryBackup(characterId: string, chatId: string, backupId: string, name: string): Promise<StoryHistoryState> {
    return serial(characterId, chatId, async () => {
        const state = await request<StoryHistoryState>('rename', { characterId, chatId, backupId, name })
        publish({ characterId, chatId, state })
        return state
    })
}
export async function quickStorySave(characterId: string, chat: Chat): Promise<StoryHistoryState> {
    const captured = await captureStoryChat(characterId, chat, 'manual')
    if (captured.mode === 'legacy') return captured
    return serial(characterId, chat.id!, async () => {
        const state = await request<StoryHistoryState>('quick', { characterId, chatId: chat.id!, backupId: captured.headId })
        publish({ characterId, chatId: chat.id!, state })
        return state
    })
}
export interface StoryTransitionResult { state: StoryHistoryState; report: { operationId: string; legacySlots: number; backups: number; estimatedBytes: number; archivePath?: string } }
function transition(action: 'migrate' | 'rollback', characterId: string, chat: Chat, options: { dryRun?: boolean } = {}): Promise<StoryTransitionResult> {
    chat.id ||= v4()
    for (const message of chat.message) message.chatId ||= v4()
    return serial(characterId, chat.id, async () => {
        const key = `risubard-story-transition:${action}:${identity(characterId, chat.id!)}`
        let operationId = options.dryRun ? v4() : transitionOperations.get(key)
        if (!options.dryRun) {
            try { operationId ??= localStorage.getItem(key) ?? undefined } catch { /* Storage can be unavailable in private contexts. */ }
            operationId ??= v4()
            transitionOperations.set(key, operationId)
            try { localStorage.setItem(key, operationId) } catch { /* Keep the in-page operation ID when browser storage is unavailable. */ }
        }
        const result = await request<StoryTransitionResult>(action, { characterId, chatId: chat.id!, chat, operationId, ...options })
        if (!options.dryRun) {
            transitionOperations.delete(key)
            try { localStorage.removeItem(key) } catch { /* The successful operation is also cleared from memory. */ }
            baselines.delete(identity(characterId, chat.id!))
            publish({ characterId, chatId: chat.id!, state: result.state })
        }
        return result
    })
}
export const migrateStoryHistory = (characterId: string, chat: Chat, options?: { dryRun?: boolean }) => transition('migrate', characterId, chat, options)
export const rollbackStoryHistory = (characterId: string, chat: Chat, options?: { dryRun?: boolean }) => transition('rollback', characterId, chat, options)

type RetryHandler = (characterId: string, chatId: string, pending: StoryPendingWiki) => Promise<boolean>
let retryHandler: RetryHandler | undefined
export function registerStoryWikiRetry(handler: RetryHandler): void { retryHandler = handler }
export async function retryStoryWiki(characterId: string, chatId: string): Promise<boolean> {
    const state = await getStoryHistory(characterId, chatId)
    if (!state.pendingWiki) return true
    if (activeWikiOperations.has(state.pendingWiki.operationId)) throw new Error('위키 확정이 진행 중입니다. 완료하거나 취소한 뒤 재시도해 주세요.')
    if (!retryHandler) throw new Error('Wiki confirmation is not available')
    return retryHandler(characterId, chatId, state.pendingWiki)
}
export async function keepStoryWiki(characterId: string, chatId: string): Promise<boolean> {
    const state = await getStoryHistory(characterId, chatId)
    if (!state.pendingWiki) return true
    if (activeWikiOperations.has(state.pendingWiki.operationId)) throw new Error('위키 확정이 진행 중입니다. 완료하거나 취소한 뒤 기존 위키로 확정해 주세요.')
    const finished = await finishStoryWiki({ characterId, chatId, operationId: state.pendingWiki.operationId, outcome: 'kept' })
    return !finished.pendingWiki
}
export async function requireStoryWikiReady(characterId: string, chatId: string): Promise<void> {
    const state = await getStoryHistory(characterId, chatId)
    if (state.pendingWiki) {
        const reason = state.pendingWiki.error ?? (state.pendingWiki.status === 'writing' ? '위키 확정이 진행 중이거나 중단되었습니다.' : '위키 확정이 완료되지 않았습니다.')
        throw new Error(`${reason} 저장 이력에서 재시도하거나 기존 위키로 확정한 뒤 진행해 주세요.`)
    }
}
