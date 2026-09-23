import { describe, expect, test, vi } from 'vitest'

const mockEmbedding = vi.hoisted(() => ({
    embedDocuments: vi.fn(),
    getEmbeds: vi.fn(),
}))
vi.mock('../process/memory/hypamemory', () => ({
    HypaProcesser: class {
        embedDocuments = mockEmbedding.embedDocuments
        getEmbeds = mockEmbedding.getEmbeds
    },
    localModels: { models: { multiMiniLM: 'local' } },
}))
import {
    createWikiEmbeddingProvider,
} from './wikiEmbeddingProvider'
import { defaultRisuBardEmbeddingSettings, normalizeRisuBardEmbeddingSettings } from './wikiEmbeddingSettings'

describe('BardWiki embedding settings', () => {
    test('does not start an embedding request when its signal is already aborted', async () => {
        const controller = new AbortController()
        controller.abort(new DOMException('cancelled', 'AbortError'))

        await expect(createWikiEmbeddingProvider(defaultRisuBardEmbeddingSettings())
            .embed(['before request'], 'query', controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' })
        expect(mockEmbedding.getEmbeds).not.toHaveBeenCalled()
        expect(mockEmbedding.embedDocuments).not.toHaveBeenCalled()
    })

    test('defaults to disabled multilingual local embedding', () => {
        expect(defaultRisuBardEmbeddingSettings()).toEqual({
            enabled: false,
            model: 'multiMiniLM',
            apiKey: '',
            custom: { url: '', key: '', model: '' },
            voyageApiKey: '',
        })
    })

    test('backfills incomplete persisted settings safely', () => {
        expect(normalizeRisuBardEmbeddingSettings({ enabled: true, custom: { url: 'http://localhost:8080' } })).toEqual({
            enabled: true,
            model: 'multiMiniLM',
            apiKey: '',
            custom: { url: 'http://localhost:8080', key: '', model: '' },
            voyageApiKey: '',
        })
    })

    test('rejects unsupported persisted models', () => {
        expect(normalizeRisuBardEmbeddingSettings({ model: 'unknown' }).model).toBe('multiMiniLM')
    })

    test('provider identity distinguishes the transport without exposing credentials', () => {
        const settings = defaultRisuBardEmbeddingSettings()
        settings.model = 'custom'
        settings.custom = { url: 'https://embeddings.example/v1', key: 'secret-key', model: 'bge-m3' }
        settings.apiKey = 'other-secret'

        const provider = createWikiEmbeddingProvider(settings)
        expect(provider.identity).toBe('wiki-embedding:custom:https://embeddings.example/v1:bge-m3')
        expect(provider.identity).not.toContain('secret')
    })
})
