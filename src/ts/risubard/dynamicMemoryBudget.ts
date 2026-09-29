import type { ResolvedRisuBardChatSettings } from './risuBardSettings'
import { isOocAssistantTurn } from './oocTurns'

export const DYNAMIC_MEMORY_PLATEAU_CHARACTERS = 500_000
const maximumGrowth = { economy: 0.25, balanced: 0.5, recall: 1 } as const

/** Quadratic ease-out joins a flat plateau with zero slope at 500,000 characters. */
export function dynamicMemoryGrowth(mode: ResolvedRisuBardChatSettings['risuBardDynamicMemoryMode'], characters: number): number {
    if (mode === 'off' || !Number.isFinite(characters)) return 0
    const progress = Math.min(1, Math.max(0, characters) / DYNAMIC_MEMORY_PLATEAU_CHARACTERS)
    return maximumGrowth[mode] * progress * (2 - progress)
}

export function countActiveMemoryTurns(messages: readonly {
    role: string; disabled?: boolean | 'allBefore'; isComment?: boolean
}[]): number {
    let count = 0
    for (const message of messages) {
        if (message.disabled === 'allBefore') count = 0
        else if (message.role === 'char' && !message.disabled && !message.isComment) count++
    }
    return count
}

export function measureActiveMemoryCharacters(messages: readonly {
    role: string; data?: string; disabled?: boolean | 'allBefore'; isComment?: boolean
}[], ignoreOoc = false): number {
    let characters = 0
    for (const message of messages) {
        if (message.disabled === 'allBefore') characters = 0
        else if (message.role === 'char' && !message.disabled && !message.isComment
            && !(ignoreOoc && isOocAssistantTurn(message))) characters += message.data?.length ?? 0
    }
    return characters
}

export function resolveDynamicMemoryBudget(settings: ResolvedRisuBardChatSettings, characterCount: number) {
    const characters = Number.isFinite(characterCount) ? Math.max(0, Math.floor(characterCount)) : 0
    const mode = settings.risuBardDynamicMemoryMode
    const baseline = {
        target: settings.risuBardInquiryTargetTokenBudget,
        events: settings.risuBardInquiryEventTokenBudget,
        perSource: settings.risuBardInquirySourceTokenBudget,
        maximum: settings.risuBardInquiryMaximumTokenBudget,
        analysis: settings.risuBardAnalysisTokenLimit,
        sourceLimit: settings.risuBardHistoricalSourceMatchLimit,
        candidateLimit: 64,
        directSeedLimit: 32,
        characterCount: characters,
        capped: false,
        mode,
    }
    if (mode === 'off') return baseline
    const growth = dynamicMemoryGrowth(mode, characters)
    const grow = (base: number) => Math.min(Number.MAX_SAFE_INTEGER, base + Math.round(base * growth))
    // The existing ceiling limits search growth, not analysis or saved baselines.
    const maximum = Math.max(baseline.maximum, Math.min(settings.risuBardDynamicMemoryMaximumTokens, grow(baseline.maximum)))
    return {
        ...baseline,
        maximum,
        capped: maximum < grow(baseline.maximum),
        target: Math.min(maximum, grow(baseline.target)),
        events: Math.min(maximum, grow(baseline.events)),
        analysis: grow(baseline.analysis),
    }
}

/** Runtime projection only: persisted settings always remain the user's baseline. */
export function resolveDynamicMemorySettings(
    settings: ResolvedRisuBardChatSettings,
    messages: Parameters<typeof measureActiveMemoryCharacters>[0],
): ResolvedRisuBardChatSettings {
    if (settings.risuBardDynamicMemoryMode === 'off') return settings
    const budget = resolveDynamicMemoryBudget(settings, measureActiveMemoryCharacters(messages, settings.risuBardIgnoreOocTurns))
    return {
        ...settings,
        risuBardInquiryTargetTokenBudget: budget.target,
        risuBardInquiryEventTokenBudget: budget.events,
        risuBardInquiryMaximumTokenBudget: budget.maximum,
        risuBardAnalysisTokenLimit: budget.analysis,
    }
}
