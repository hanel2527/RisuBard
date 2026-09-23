import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { WikiEmbeddingRuntime } from '../../ts/risubard/wikiEmbeddingRuntime'

it('keeps embedding work alive when the screen effect reruns for the same chat', async () => {
    const source = readFileSync(resolve('src/lib/ChatScreens/ChatScreen.svelte'), 'utf8')
    const effect = source.slice(source.indexOf('    $effect(() => {'), source.indexOf('    function openSaveSlots'))
    const cleanup = effect.slice(effect.indexOf('return () => {'))
    // Reactive chat/database replacement also runs effect cleanup. Only unmount owns stop.
    expect(cleanup).not.toContain('wikiEmbeddingRuntime.stop()')
    expect(source).toMatch(/onDestroy\(\(\) => wikiEmbeddingRuntime\.stop\(\)\)/)

    let signal: AbortSignal | undefined
    const embed = vi.fn((_texts: string[], _purpose: string, abort?: AbortSignal) => {
        signal = abort
        return new Promise<number[][]>(() => {})
    })
    const runtime = new WikiEmbeddingRuntime({
        provider: (_settings: { enabled: boolean }) => ({ identity: 'model', embed }),
        cache: { read: async () => undefined, write: async () => {} },
        load: async () => ({ revision: 'r', chunks: [{ documentId: 'a', contentHash: 'h', text: 'text', start: 0, end: 4 }], nextOffset: null }),
    })
    runtime.activate({ characterId: 'c', chatId: 'a' }, { enabled: true })
    await vi.waitFor(() => expect(embed).toHaveBeenCalledOnce())
    runtime.activate({ characterId: 'c', chatId: 'a' }, { enabled: true })
    expect(embed).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(false)
    runtime.stop()
    expect(signal?.aborted).toBe(true)
})
