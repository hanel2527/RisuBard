// Reactive state used only by the embedding settings DOM tests.
export const testEmbeddingState = $state({ db: {
    risuBardEmbeddingSettings: { enabled: true, model: 'multiMiniLM', apiKey: '', custom: { url: '', key: '', model: '' }, voyageApiKey: '' },
    hypaModel: 'multiMiniLM', supaMemoryKey: '',
    hypaCustomSettings: { url: '', key: '', model: '' }, voyageApiKey: '', hideApiKey: true,
} })
