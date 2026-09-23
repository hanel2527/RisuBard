import {
    HypaProcesser,
    localModels,
    type HypaEmbeddingConfig,
} from '../process/memory/hypamemory'
import type { RisuBardEmbeddingSettings } from './wikiEmbeddingSettings'
export {
    defaultRisuBardEmbeddingSettings,
    normalizeRisuBardEmbeddingSettings,
    type RisuBardEmbeddingSettings,
    type WikiEmbeddingSettings,
} from './wikiEmbeddingSettings'

export interface WikiEmbeddingProvider {
    /** Provider identity deliberately excludes credentials. */
    readonly identity: string
    embed(texts: string[], purpose: 'document' | 'query', abortSignal?: AbortSignal): Promise<number[][]>
}

const REQUEST_TIMEOUT_MS = 30_000

export function createWikiEmbeddingProvider(settings: RisuBardEmbeddingSettings): WikiEmbeddingProvider {
    const config: HypaEmbeddingConfig = Object.freeze({
        customEmbeddingUrl: settings.custom.url,
        customEmbeddingKey: settings.custom.key,
        customEmbeddingModel: settings.custom.model,
        openAIKey: settings.apiKey,
        voyageApiKey: settings.voyageApiKey,
    })
    const model = settings.model
    const endpoint = model === 'custom' ? settings.custom.url.trim() : ''
    const customModel = model === 'custom' ? settings.custom.model.trim() : ''
    const local = Object.hasOwn(localModels.models, model)
    const identity = `wiki-embedding:${model}:${endpoint}:${customModel}`
    const processor = new HypaProcesser(model, settings.custom.url, config)

    return {
        identity,
        async embed(texts, purpose, abortSignal) {
            if (texts.length === 0) return []
            if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException('BardWiki embedding aborted', 'AbortError')
            const controller = new AbortController()
            const timeout = local
                ? undefined
                : setTimeout(() => controller.abort(new DOMException('BardWiki embedding timed out', 'TimeoutError')), REQUEST_TIMEOUT_MS)
            const forwardAbort = () => controller.abort(abortSignal?.reason)
            abortSignal?.addEventListener('abort', forwardAbort, { once: true })
            try {
                const request = purpose === 'document'
                    ? processor.embedDocuments(texts, controller.signal)
                    : processor.getEmbeds(texts, 'query', controller.signal)
                const vectors = await Promise.race([
                    request,
                    new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason ?? new DOMException('BardWiki embedding aborted', 'AbortError')), { once: true })),
                ])
                return vectors.map((vector) => Array.from(vector))
            } finally {
                if (timeout !== undefined) clearTimeout(timeout)
                abortSignal?.removeEventListener('abort', forwardAbort)
            }
        },
    }
}
