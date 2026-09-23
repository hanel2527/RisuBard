import type { HypaModel } from '../process/memory/hypamemory'

export interface RisuBardEmbeddingSettings {
    enabled: boolean
    model: HypaModel
    apiKey: string
    custom: { url: string, key: string, model: string }
    voyageApiKey: string
}

export type WikiEmbeddingSettings = RisuBardEmbeddingSettings

export interface SharedHypaEmbeddingSettings {
    risuBardEmbeddingSettings?: unknown
    hypaModel?: string
    supaMemoryKey?: string
    hypaCustomSettings?: { url?: string; key?: string; model?: string }
    voyageApiKey?: string
}

/** Hypa owns the connection. BardWiki owns only whether to use it. */
export function resolveSharedWikiEmbeddingSettings(db: SharedHypaEmbeddingSettings): RisuBardEmbeddingSettings {
    return normalizeRisuBardEmbeddingSettings({
        enabled: normalizeRisuBardEmbeddingSettings(db.risuBardEmbeddingSettings).enabled,
        model: db.hypaModel ?? 'MiniLM',
        apiKey: db.supaMemoryKey,
        custom: db.hypaCustomSettings,
        voyageApiKey: db.voyageApiKey,
    })
}

const supportedModels = new Set<HypaModel>([
    'custom', 'ada', 'openai3small', 'openai3large', 'MiniLM', 'MiniLMGPU',
    'nomic', 'nomicGPU', 'bgeSmallEn', 'bgeSmallEnGPU', 'bgem3', 'bgem3GPU',
    'multiMiniLM', 'multiMiniLMGPU', 'bgeM3Ko', 'bgeM3KoGPU', 'voyageContext3',
])

export const defaultRisuBardEmbeddingSettings = (): RisuBardEmbeddingSettings => ({
    enabled: false,
    model: 'multiMiniLM',
    apiKey: '',
    custom: { url: '', key: '', model: '' },
    voyageApiKey: '',
})

export function normalizeRisuBardEmbeddingSettings(value: unknown): RisuBardEmbeddingSettings {
    const fallback = defaultRisuBardEmbeddingSettings()
    if (!value || typeof value !== 'object') return fallback
    const candidate = value as Partial<RisuBardEmbeddingSettings>
    return {
        enabled: candidate.enabled === true,
        model: typeof candidate.model === 'string' && supportedModels.has(candidate.model as HypaModel)
            ? candidate.model as HypaModel
            : fallback.model,
        apiKey: typeof candidate.apiKey === 'string' ? candidate.apiKey : '',
        custom: {
            url: typeof candidate.custom?.url === 'string' ? candidate.custom.url : '',
            key: typeof candidate.custom?.key === 'string' ? candidate.custom.key : '',
            model: typeof candidate.custom?.model === 'string' ? candidate.custom.model : '',
        },
        voyageApiKey: typeof candidate.voyageApiKey === 'string' ? candidate.voyageApiKey : '',
    }
}
