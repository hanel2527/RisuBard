import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const mocks = vi.hoisted(() => ({
    embed: vi.fn(), provider: vi.fn(), read: vi.fn(), write: vi.fn(),
}))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { createAuth: async () => 'test-auth' } }))
vi.mock('../storage/persistentKv', () => ({
    makeHashedStorageKey: async (_prefix: string, key: string) => `hashed:${key.length}`,
    readPersistentJson: mocks.read, writePersistentJson: mocks.write,
}))
vi.mock('./wikiEmbeddingProvider', () => ({ createWikiEmbeddingProvider: mocks.provider }))

import {
    historicalSourceEmbeddingStatus, refreshHistoricalSourceEmbeddings,
    searchHistoricalSourceEmbeddings, stopHistoricalSourceEmbeddings,
    activateHistoricalSourceEmbeddings,
} from './wikiEmbeddingService'

const enabled = { risuBardEmbeddingSettings: { enabled: true }, hypaModel: 'MiniLM' }
const messages = [
    { role: 'char', chatId: 'old', data: '북문에서 은색 반지를 건넸다.' },
    { role: 'user', chatId: 'user', data: '현재 질문' },
    { role: 'char', chatId: 'new', data: '현재 장면' },
]
const options = { ignoreOocTurns: true, excludeRecentMessages: 1, maximumMatches: 8 }

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
}

beforeEach(() => {
    stopHistoricalSourceEmbeddings()
    vi.clearAllMocks()
    mocks.embed.mockReset().mockImplementation(async (texts: string[]) => texts.map(() => [1, 0]))
    mocks.provider.mockImplementation(() => ({ identity: 'service-test', embed: mocks.embed }))
    mocks.read.mockResolvedValue(undefined)
    mocks.write.mockResolvedValue(undefined)
})
afterEach(() => stopHistoricalSourceEmbeddings())

describe('historical embedding service lifecycle', () => {
    it('retains the ready index while streaming but invalidates changed configuration without rebuilding', async () => {
        refreshHistoricalSourceEmbeddings('c', 'streaming', enabled, messages)
        await vi.waitFor(() => expect(get(historicalSourceEmbeddingStatus)).toBe('ready'))
        const calls = mocks.embed.mock.calls.length
        activateHistoricalSourceEmbeddings('c', 'streaming', enabled)
        expect(get(historicalSourceEmbeddingStatus)).toBe('ready')
        expect(mocks.embed.mock.calls.length).toBe(calls)
        activateHistoricalSourceEmbeddings('c', 'other-chat', enabled)
        expect(await searchHistoricalSourceEmbeddings('streaming query', '', messages, options)).toEqual([])
        expect(mocks.embed.mock.calls.length).toBe(calls)
        activateHistoricalSourceEmbeddings('c', 'other-chat', {risuBardEmbeddingSettings:{enabled:false}})
        expect(get(historicalSourceEmbeddingStatus)).toBe('disabled')
    })
    it('does no original-source or query embedding work when disabled', async () => {
        refreshHistoricalSourceEmbeddings('c', 'chat', { risuBardEmbeddingSettings: { enabled: false } }, messages)
        expect(await searchHistoricalSourceEmbeddings('반지', '', messages, options)).toEqual([])
        expect(get(historicalSourceEmbeddingStatus)).toBe('disabled')
        expect(mocks.embed).not.toHaveBeenCalled()
        expect(mocks.read).not.toHaveBeenCalled()
    })

    it('returns no semantic evidence from a cold index until background preparation completes', async () => {
        const pending = deferred<number[][]>()
        mocks.embed.mockImplementationOnce(() => pending.promise)
        refreshHistoricalSourceEmbeddings('c', 'cold', enabled, messages)
        await vi.waitFor(() => expect(mocks.embed).toHaveBeenCalledOnce())
        expect(await searchHistoricalSourceEmbeddings('cold query', '', messages, options)).toEqual([])
        expect(get(historicalSourceEmbeddingStatus)).toBe('preparing')
        pending.resolve([[1, 0], [1, 0], [1, 0]])
        await vi.waitFor(() => expect(get(historicalSourceEmbeddingStatus)).toBe('ready'))
        expect((await searchHistoricalSourceEmbeddings('cold query', '', messages, options)).map((match) => match.messageId)).toEqual(['old'])
    })

    it('aborts original-source requests and drops late results when disabled', async () => {
        const pending = deferred<number[][]>()
        mocks.embed.mockImplementationOnce(() => pending.promise)
        refreshHistoricalSourceEmbeddings('c', 'disable', enabled, messages)
        await vi.waitFor(() => expect(mocks.embed).toHaveBeenCalledOnce())
        const signal = mocks.embed.mock.calls[0][2] as AbortSignal
        refreshHistoricalSourceEmbeddings('c', 'disable', { risuBardEmbeddingSettings: { enabled: false } }, messages)
        expect(signal.aborted).toBe(true)
        pending.resolve([[1, 0], [1, 0], [1, 0]])
        await Promise.resolve()
        expect(get(historicalSourceEmbeddingStatus)).toBe('disabled')
        expect(await searchHistoricalSourceEmbeddings('disabled query', '', messages, options)).toEqual([])
    })

    it('suppresses a completed old-scope query after switching chats', async () => {
        refreshHistoricalSourceEmbeddings('c', 'scope-a', enabled, messages)
        await vi.waitFor(() => expect(get(historicalSourceEmbeddingStatus)).toBe('ready'))
        const pending = deferred<number[][]>()
        mocks.embed.mockImplementationOnce(() => pending.promise)
        const result = searchHistoricalSourceEmbeddings('unique scope query', '', messages, options)
        await vi.waitFor(() => expect(mocks.embed.mock.calls.some((call) => call[1] === 'query')).toBe(true))
        refreshHistoricalSourceEmbeddings('c', 'scope-b', enabled, messages.map((message) => ({ ...message, chatId: `b-${message.chatId}` })))
        pending.resolve([[1, 0]])
        expect(await result).toEqual([])
    })

    it('replaces the provider and cancels old original-source work after settings change', async () => {
        const pending = deferred<number[][]>()
        mocks.embed.mockImplementationOnce(() => pending.promise)
        refreshHistoricalSourceEmbeddings('c', 'provider', { ...enabled, hypaModel: 'multiMiniLM' }, messages)
        await vi.waitFor(() => expect(mocks.embed).toHaveBeenCalledOnce())
        const signal = mocks.embed.mock.calls[0][2] as AbortSignal
        refreshHistoricalSourceEmbeddings('c', 'provider', { ...enabled, hypaModel: 'bgeSmallEn' }, messages)
        expect(signal.aborted).toBe(true)
        expect(mocks.provider.mock.calls.at(-1)?.[0]).toMatchObject({ model: 'bgeSmallEn' })
        pending.resolve([[1, 0], [1, 0], [1, 0]])
        await vi.waitFor(() => expect(get(historicalSourceEmbeddingStatus)).toBe('ready'))
    })

    it('does not announce ready when an older refresh ends before its replacement finishes', async () => {
        const first = deferred<number[][]>()
        const second = deferred<number[][]>()
        mocks.embed.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
        refreshHistoricalSourceEmbeddings('c', 'refresh-race', enabled, messages)
        await vi.waitFor(() => expect(mocks.embed).toHaveBeenCalledOnce())
        refreshHistoricalSourceEmbeddings('c', 'refresh-race', enabled,
            messages.map((message) => message.chatId === 'old' ? { ...message, data: '새로 확인된 출처' } : message))
        first.resolve([[1, 0], [1, 0], [1, 0]])
        await vi.waitFor(() => expect(mocks.embed).toHaveBeenCalledTimes(2))
        expect(get(historicalSourceEmbeddingStatus)).toBe('preparing')
        second.resolve([[1, 0], [1, 0], [1, 0]])
        await vi.waitFor(() => expect(get(historicalSourceEmbeddingStatus)).toBe('ready'))
    })
})
