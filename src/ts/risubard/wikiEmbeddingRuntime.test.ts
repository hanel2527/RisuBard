import { expect, it, vi } from 'vitest'
import { WikiEmbeddingRuntime } from './wikiEmbeddingRuntime'

function fixture() {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
    const load = vi.fn(async () => ({ revision: 'r', chunks: [{ documentId: 'event', contentHash: 'h', text: 'promise', start: 0, end: 7 }], nextOffset: null }))
    const runtime = new WikiEmbeddingRuntime({
        provider: (_settings: { enabled: boolean; model?: string }) => ({ identity: 'model', embed }),
        cache: { read: async () => undefined, write: async () => {} }, load,
    })
    return { runtime, embed, load }
}

it('does no catalog or model work when disabled', async () => {
    const { runtime, load, embed } = fixture()
    runtime.activate({ characterId: 'c', chatId: 'a' }, { enabled: false })
    expect((await runtime.search('question', '')).matches).toEqual([])
    expect(load).not.toHaveBeenCalled()
    expect(embed).not.toHaveBeenCalled()
})

it('prepares outside search and scopes snapshots to the active chat', async () => {
    const { runtime, load } = fixture()
    runtime.activate({ characterId: 'c', chatId: 'a' }, { enabled: true })
    await vi.waitFor(() => expect(runtime.status).toBe('ready'))
    expect((await runtime.search('question', '')).matches[0].documentId).toBe('event')
    load.mockImplementationOnce(() => new Promise(() => {}))
    runtime.activate({ characterId: 'c', chatId: 'b' }, { enabled: true })
    expect((await runtime.search('question', '')).matches).toEqual([])
    runtime.stop()
})

it('refreshes after saves and suppresses results after disabling during a query', async () => {
    const { runtime, embed, load } = fixture()
    runtime.activate({ characterId: 'c', chatId: 'a' }, { enabled: true })
    await vi.waitFor(() => expect(runtime.status).toBe('ready'))
    runtime.refresh()
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    let resolve!: (vectors: number[][]) => void
    embed.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const result = runtime.search('question', '')
    runtime.stop()
    resolve([[1, 0]])
    expect((await result).matches).toEqual([])
})
