import type { Chat } from '../storage/database.svelte'

export const DEFAULT_RISUBARD_AUTOSAVE_INTERVAL = 5
export const DEFAULT_RISUBARD_AUTOSAVE_RETENTION = 5
export const MAX_RISUBARD_AUTOSAVE_INTERVAL = 100
export const MAX_RISUBARD_AUTOSAVE_RETENTION = 20

export function applyMemorySavePromptSettings(chat: Chat, currentChat?: Chat): void {
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

export function prepareMemorySaveChatSnapshot(chat: Chat): void {
    applyMemorySavePromptSettings(chat)
    delete chat._placeholder
    chat.isStreaming = false
    delete chat.activeStreamingDisplayOptimizationMode
}

const QUICK_PREFIX = '__risubard_quick__'
const AUTO_PREFIX = '__risubard_auto__'

function boundedInteger(
    value: unknown,
    fallback: number,
    maximum: number,
): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(maximum, Math.max(1, Math.floor(value)))
}

export function normalizeAutosaveInterval(value: unknown): number {
    return boundedInteger(
        value,
        DEFAULT_RISUBARD_AUTOSAVE_INTERVAL,
        MAX_RISUBARD_AUTOSAVE_INTERVAL,
    )
}

export function normalizeAutosaveRetention(value: unknown): number {
    return boundedInteger(
        value,
        DEFAULT_RISUBARD_AUTOSAVE_RETENTION,
        MAX_RISUBARD_AUTOSAVE_RETENTION,
    )
}

function hash(value: string, seed: number): string {
    let result = seed >>> 0
    for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index)
        result = Math.imul(result, 16_777_619)
    }
    return (result >>> 0).toString(36)
}

function chatKey(chatId: string): string {
    const trimmed = chatId.trim()
    if (!trimmed) throw new Error('Chat ID is required for a reserved save slot')
    if (/^[A-Za-z0-9_-]{1,128}$/.test(trimmed)) return trimmed
    return `${hash(trimmed, 2_166_136_261)}${hash(trimmed, 3_332_669_303)}`
}

export function quickSaveId(chatId: string): string {
    return `${QUICK_PREFIX}${chatKey(chatId)}`
}

export function shouldCreateAutosave(
    turnCount: number,
    intervalValue: unknown,
    lastAutosaveTurn?: number,
): boolean {
    if (!Number.isSafeInteger(turnCount) || turnCount < 1) return false
    const interval = normalizeAutosaveInterval(intervalValue)
    return (turnCount - 1) % interval === 0
        && lastAutosaveTurn !== turnCount
}

export function autoSaveId(
    chatId: string,
    turnCount: number,
    intervalValue: unknown,
    retentionValue: unknown,
): string {
    if (!Number.isSafeInteger(turnCount) || turnCount < 1) {
        throw new Error('Autosave turn must be a positive safe integer')
    }
    const interval = normalizeAutosaveInterval(intervalValue)
    const retention = normalizeAutosaveRetention(retentionValue)
    const index = Math.floor((turnCount - 1) / interval) % retention
    return `${AUTO_PREFIX}${chatKey(chatId)}__${index}`
}

export function classifyMemorySaveId(saveId: string):
    | { kind: 'quick' }
    | { kind: 'auto'; index: number }
    | { kind: 'manual' } {
    if (saveId.startsWith(QUICK_PREFIX)) return { kind: 'quick' }
    if (saveId.startsWith(AUTO_PREFIX)) {
        const match = /__(\d+)$/.exec(saveId)
        if (match) return { kind: 'auto', index: Number(match[1]) }
    }
    return { kind: 'manual' }
}

export function obsoleteAutosaveIds(
    saveIds: readonly string[],
    chatId: string,
    retentionValue: unknown,
): string[] {
    const prefix = `${AUTO_PREFIX}${chatKey(chatId)}__`
    const retention = normalizeAutosaveRetention(retentionValue)
    return saveIds.filter((saveId) => {
        if (!saveId.startsWith(prefix)) return false
        const match = /__(\d+)$/.exec(saveId)
        return Boolean(match && Number(match[1]) >= retention)
    })
}
