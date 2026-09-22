import { writable } from 'svelte/store'
import { forageStorage } from '../globalApi.svelte'
import { makeHashedStorageKey, readPersistentJson, writePersistentJson } from '../storage/persistentKv'
import { createWikiEmbeddingProvider } from './wikiEmbeddingProvider'
import { resolveSharedWikiEmbeddingSettings, type SharedHypaEmbeddingSettings } from './wikiEmbeddingSettings'
import { WikiEmbeddingRuntime, type WikiEmbeddingStatus } from './wikiEmbeddingRuntime'
import type { WikiEmbeddingCatalog } from './wikiEmbeddingChunks'

export const wikiEmbeddingStatus = writable<WikiEmbeddingStatus>('disabled')

const cacheKey = (key: string) => makeHashedStorageKey('cache/bardwiki-vector/', key)

export const wikiEmbeddingRuntime = new WikiEmbeddingRuntime({
    provider: createWikiEmbeddingProvider,
    onStatus: status => wikiEmbeddingStatus.set(status),
    cache: {
        read: async key => (await readPersistentJson<number[]>(await cacheKey(key))) ?? undefined,
        write: async (key, vector) => writePersistentJson(await cacheKey(key), vector),
    },
    async load(scope, offset, revision): Promise<WikiEmbeddingCatalog> {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10_000)
        try {
            const response = await fetch('/api/risubard/memory/embedding-catalog', {
                method: 'POST', signal: controller.signal,
                headers: { 'content-type': 'application/json', 'risu-auth': await forageStorage.createAuth() },
                body: JSON.stringify({ ...scope, offset, ...(revision ? { revision } : {}) }),
            })
            if (!response.ok) throw new Error('Embedding catalog unavailable')
            const value = await response.json() as WikiEmbeddingCatalog
            if (typeof value?.revision !== 'string' || !Array.isArray(value.chunks)
                || value.chunks.length > 64
                || !(value.nextOffset === null || (Number.isSafeInteger(value.nextOffset) && value.nextOffset > offset))
                || !value.chunks.every(chunk => typeof chunk.documentId === 'string'
                    && typeof chunk.contentHash === 'string' && typeof chunk.text === 'string'
                    && chunk.text.length <= 1000 && Number.isSafeInteger(chunk.start)
                    && Number.isSafeInteger(chunk.end) && chunk.start >= 0 && chunk.end > chunk.start)) {
                throw new Error('Invalid embedding catalog')
            }
            return value
        } finally { clearTimeout(timeout) }
    },
})

export function activateWikiEmbeddings(characterId: string, chatId: string, settings: SharedHypaEmbeddingSettings): void {
    wikiEmbeddingRuntime.activate({ characterId, chatId }, resolveSharedWikiEmbeddingSettings(settings))
}
