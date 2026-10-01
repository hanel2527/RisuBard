import type { ContextSource } from '../../../packages/risubard-core/src/contextCompiler'
import type { OpenAIChat } from '../process/index.svelte'
import { createNarrativeSourcesPrompt } from './narrativeContext'

export interface WikiInquiryBudget {
    target: number
    events: number
    perSource: number
    maximum: number
}

export function reserveRequiredWikiBudget(budget: WikiInquiryBudget, sources: readonly ContextSource[]): WikiInquiryBudget | null {
    const maximum = budget.maximum - sources.reduce((sum, source) => sum + source.tokens, 0)
    if (maximum < 0) throw new Error('필수 위키가 전체 위키 토큰 상한을 초과했습니다.')
    // Inquiry settings have a 256-token minimum; never round the remaining budget up.
    if (maximum < 256) return null
    return { target: Math.min(budget.target, maximum), events: Math.min(budget.events, maximum),
        perSource: Math.min(budget.perSource, maximum), maximum }
}

export function createRequiredWikiMessage(sources: readonly ContextSource[], responseGuide = ''): OpenAIChat | null {
    if (!sources.length) return null
    return {
        role: 'system', removable: false,
        content: createNarrativeSourcesPrompt(sources, '', undefined, responseGuide)!,
        requestStatusSources: sources.map(source => ({
            kind: 'wiki', role: 'system', content: source.content,
            name: `항상 포함 / ${source.id.replace('narrative-memory:wiki:', '')}`,
        })),
    }
}
