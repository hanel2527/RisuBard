export const bardLoreFailureReasons = ['outputLimit', 'inputLimit', 'blocked', 'empty', 'invalidJson', 'validation', 'requestFailed'] as const
export interface BardLoreAnalysisDiagnostic {
    reason: typeof bardLoreFailureReasons[number]
    details: string
}

export interface BardLoreFailureContext {
    error: string
    responseType?: string
    responseText?: string
    finishReason?: string
    model?: string
    usage?: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number }
    entryCount?: number
    estimatedInputTokens?: number
    inputTokenLimit?: number
    outputTokenLimit?: number
    attempt?: number
}

function excerpt(text: string): string {
    return text.length <= 4000 ? text : `${text.slice(0, 2000)}\n...[excerpt: middle omitted]...\n${text.slice(-2000)}`
}

export function diagnoseBardLoreAnalysisFailure(context: BardLoreFailureContext): BardLoreAnalysisDiagnostic {
    const { error, responseText, ...metadata } = context
    // Only provider metadata / error messages are evidence of token exhaustion or blocking.
    // Never classify story text or a large batch as proof of either.
    const finishReason = context.finishReason
        || error.match(/finish[_ ]reason\s*[:=]\s*["']?([\w-]+)/i)?.[1]
    const finish = finishReason?.toLowerCase()
    let reason: BardLoreAnalysisDiagnostic['reason']
    if (['length', 'max_tokens', 'max_output_tokens'].includes(finish ?? '')) {
        reason = 'outputLimit'
    } else if (['safety', 'content_filter', 'refusal', 'recitation', 'blocklist', 'prohibited_content', 'spii', 'image_safety'].includes(finish ?? '')
        || /^Gemini blocked the prompt:/i.test(error)) {
        reason = 'blocked'
    } else if (/context_length_exceeded|maximum context length|context window.{0,40}(exceed|limit)|prompt is too long|input.{0,30}tokens?.{0,30}exceed/i.test(error)) {
        reason = 'inputLimit'
    } else if (/invalid-json|not valid JSON/i.test(error)) {
        reason = context.responseType === 'success' && !responseText?.trim() ? 'empty' : 'invalidJson'
    } else if (error.startsWith('bard-lore-analysis-invalid:') || error.startsWith('bard-lore-analysis-quality:')
        || /structured[- ]output validation failed/i.test(error)) {
        reason = 'validation'
    } else {
        reason = 'requestFailed'
    }
    return {
        reason,
        details: JSON.stringify({
            ...metadata,
            finishReason: finishReason ?? null,
            usage: context.usage ?? null,
            error: excerpt(error),
            responseCharacters: responseText?.length ?? null,
            responseExcerpt: responseText === undefined ? null : excerpt(responseText),
        }, null, 2),
    }
}

export function normalizeBardLoreAnalysisDiagnostic(value: unknown): BardLoreAnalysisDiagnostic | undefined {
    if (!value || typeof value !== 'object') return undefined
    const raw = value as BardLoreAnalysisDiagnostic
    return bardLoreFailureReasons.includes(raw.reason) && typeof raw.details === 'string'
        ? { reason: raw.reason, details: raw.details.slice(0, 20000) }
        : undefined
}
