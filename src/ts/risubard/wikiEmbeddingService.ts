import { writable } from 'svelte/store'
import { forageStorage } from '../globalApi.svelte'
import { makeHashedStorageKey, readPersistentJson, writePersistentJson } from '../storage/persistentKv'
import { createWikiEmbeddingProvider } from './wikiEmbeddingProvider'
import { resolveSharedWikiEmbeddingSettings, type SharedHypaEmbeddingSettings } from './wikiEmbeddingSettings'
import { WikiEmbeddingRuntime, type WikiEmbeddingStatus } from './wikiEmbeddingRuntime'
import type { WikiEmbeddingCatalog } from './wikiEmbeddingChunks'
import { HistoricalSourceEmbeddingIndex, shareQueryEmbeddings, type HistoricalSearchOptions } from './historicalSourceEmbedding'
import type { HistoricalSourceMessage } from './historicalSourceRecall'
import type { RisuBardEmbeddingSettings } from './wikiEmbeddingSettings'
import type { WikiVectorProvider } from './wikiEmbeddingIndex'

export const wikiEmbeddingStatus = writable<WikiEmbeddingStatus>('disabled')

const cacheKey = (key: string) => makeHashedStorageKey('cache/bardwiki-vector/', key)
const vectorCache = {
    read: async (key: string) => (await readPersistentJson<number[]>(await cacheKey(key))) ?? undefined,
    write: async (key: string, vector: number[]) => writePersistentJson(await cacheKey(key), vector),
}
let sharedProvider: { key: string; provider: WikiVectorProvider } | undefined
function providerFor(settings: RisuBardEmbeddingSettings): WikiVectorProvider {
    const key = JSON.stringify(settings)
    if (sharedProvider?.key !== key) sharedProvider = {key, provider:shareQueryEmbeddings(createWikiEmbeddingProvider(settings))}
    return sharedProvider.provider
}
let historicalEntry: {key: string; index: HistoricalSourceEmbeddingIndex; revision: number} | undefined
export const historicalSourceEmbeddingStatus = writable<WikiEmbeddingStatus>('disabled')

export function stopHistoricalSourceEmbeddings(): void {
    historicalEntry?.index.dispose()
    historicalEntry = undefined
    historicalSourceEmbeddingStatus.set('disabled')
}

export function activateHistoricalSourceEmbeddings(characterId: string, chatId: string, settings: SharedHypaEmbeddingSettings): void {
    const resolved = resolveSharedWikiEmbeddingSettings(settings)
    if (!resolved.enabled) { stopHistoricalSourceEmbeddings(); return }
    const key = JSON.stringify([characterId, chatId, resolved])
    try {
        if (historicalEntry?.key !== key) {
            stopHistoricalSourceEmbeddings()
            historicalEntry = {key, index:new HistoricalSourceEmbeddingIndex(providerFor(resolved), vectorCache), revision:0}
            historicalSourceEmbeddingStatus.set('preparing')
        }
    } catch { historicalSourceEmbeddingStatus.set('unavailable') }
}

export function refreshHistoricalSourceEmbeddings(characterId: string, chatId: string, settings: SharedHypaEmbeddingSettings,
    messages: readonly HistoricalSourceMessage[], ignoreOocTurns = true): void {
    activateHistoricalSourceEmbeddings(characterId, chatId, settings)
    const entry = historicalEntry
    if (!entry) return
    try {
        const revision = ++entry.revision
        historicalSourceEmbeddingStatus.set('preparing')
        void entry.index.refresh(messages, ignoreOocTurns).then(() => {
            if (historicalEntry === entry && entry.revision === revision) historicalSourceEmbeddingStatus.set('ready')
        }).catch(() => {
            if (historicalEntry === entry && entry.revision === revision) historicalSourceEmbeddingStatus.set('unavailable')
        })
    } catch { historicalSourceEmbeddingStatus.set('unavailable') }
}

export async function searchHistoricalSourceEmbeddings(current: string, recent: string, messages: readonly HistoricalSourceMessage[], options: HistoricalSearchOptions) {
    const entry = historicalEntry
    const result = await entry?.index.search(current, recent, messages, options)
    return entry && historicalEntry === entry ? result ?? [] : []
}

export const wikiEmbeddingRuntime = new WikiEmbeddingRuntime({
    provider: providerFor,
    onStatus: status => wikiEmbeddingStatus.set(status),
    cache: vectorCache,
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
