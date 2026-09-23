import { expect, it } from 'vitest'
import { resolveSharedWikiEmbeddingSettings } from './wikiEmbeddingSettings'

it('uses Hypa connection fields and only the BardWiki enable flag', () => {
    const db = {
        hypaModel: 'custom', supaMemoryKey: 'openai-key', voyageApiKey: 'voyage-key',
        hypaCustomSettings: { url: 'https://openrouter.ai/api/v1/embeddings', key: 'router-key', model: 'qwen/qwen3-embedding-8b' },
        risuBardEmbeddingSettings: { enabled: true, model: 'multiMiniLM', apiKey: 'obsolete' },
    }
    expect(resolveSharedWikiEmbeddingSettings(db)).toEqual({
        enabled: true, model: 'custom', apiKey: 'openai-key', voyageApiKey: 'voyage-key', custom: db.hypaCustomSettings,
    })
    db.hypaCustomSettings.model = 'another-model'
    expect(resolveSharedWikiEmbeddingSettings(db).custom.model).toBe('another-model')
    db.risuBardEmbeddingSettings.enabled = false
    expect(resolveSharedWikiEmbeddingSettings(db).enabled).toBe(false)
})
