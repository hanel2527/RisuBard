import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    globalFetch: vi.fn(),
    database: {
        hypaModel: 'MiniLM',
        hypaCustomSettings: { url: 'https://global.example/v1', key: 'global-key', model: 'global-model' },
        supaMemoryKey: 'global-openai-key',
    },
}))

vi.mock('src/ts/globalApi.svelte', () => ({ globalFetch: mocks.globalFetch }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => mocks.database }))
vi.mock('../transformers', () => ({ runEmbedding: vi.fn() }))
vi.mock('src/ts/util', () => ({ appendLastPath: (base: string, path: string) => `${base.replace(/\/$/, '')}/${path}` }))
vi.mock('src/ts/storage/persistentKv', () => ({
    makeHashedStorageKey: vi.fn(), readPersistentJson: vi.fn(), writePersistentJson: vi.fn(),
}))
vi.mock('./contextualEmbedding', () => ({ isContextModel: () => false, getContextProvider: vi.fn() }))
vi.mock('src/ts/network/localNetwork', () => ({ isLocalNetworkUrl: () => false }))

beforeEach(() => {
    vi.resetModules()
    mocks.globalFetch.mockReset().mockResolvedValue({ ok: true, data: { data: [{ embedding: [1, 0] }] } })
    mocks.database.hypaCustomSettings = { url: 'https://global.example/v1', key: 'global-key', model: 'global-model' }
    mocks.database.supaMemoryKey = 'global-openai-key'
})

describe('HypaProcesser explicit embedding configuration', () => {
    test('uses isolated custom URL, key, and model without mutating global Hypa settings', async () => {
        const { HypaProcesser } = await import('./hypamemory')
        const processor = new HypaProcesser('custom', undefined, {
            customEmbeddingUrl: 'https://wiki.example/v1',
            customEmbeddingKey: 'wiki-key',
            customEmbeddingModel: 'wiki-model',
        })

        await processor.getEmbeds(['wiki document'])

        expect(mocks.globalFetch).toHaveBeenCalledWith('https://wiki.example/v1/embeddings', expect.objectContaining({
            headers: { Authorization: 'Bearer wiki-key' },
            body: { input: ['wiki document'], model: 'wiki-model' },
        }))
        expect(mocks.database.hypaCustomSettings).toEqual({
            url: 'https://global.example/v1', key: 'global-key', model: 'global-model',
        })
    })

    test('does not fall back to the global OpenAI key when an explicit key is empty', async () => {
        const { HypaProcesser } = await import('./hypamemory')
        await new HypaProcesser('openai3small', undefined, { openAIKey: '' }).getEmbeds(['query'])

        expect(mocks.globalFetch).toHaveBeenCalledWith('https://api.openai.com/v1/embeddings', expect.objectContaining({
            headers: { Authorization: 'Bearer ' },
        }))
    })

    test('retains the existing global fallback when no explicit config is provided', async () => {
        const { HypaProcesser } = await import('./hypamemory')
        await new HypaProcesser('openai3small').getEmbeds(['query'])

        expect(mocks.globalFetch).toHaveBeenCalledWith('https://api.openai.com/v1/embeddings', expect.objectContaining({
            headers: { Authorization: 'Bearer global-openai-key' },
        }))
    })
})
