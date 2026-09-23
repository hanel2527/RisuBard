import { describe, expect, it, vi } from 'vitest'
import { PluginContextCache } from './pluginContextCache'

describe('plugin compatibility context cache', () => {
    it('shares concurrent and sequential polling results', async () => {
        const cache = new PluginContextCache<string>()
        const load = vi.fn(async () => 'memory')
        expect(await Promise.all(Array.from({ length: 30 }, () => cache.get('chat', load))))
            .toEqual(Array(30).fill('memory'))
        for (let i = 0; i < 30; i++) await cache.get('chat', load)
        expect(load).toHaveBeenCalledTimes(1)
        await cache.get('changed-chat', load)
        expect(load).toHaveBeenCalledTimes(2)
    })

    it('expires results and retries failures', async () => {
        const cache = new PluginContextCache<string>(0)
        const load = vi.fn(async () => 'memory')
        await cache.get('chat', load)
        await cache.get('chat', load)
        expect(load).toHaveBeenCalledTimes(2)
        const retry = new PluginContextCache<string>()
        await expect(retry.get('chat', async () => { throw Error('offline') })).rejects.toThrow('offline')
        expect(await retry.get('chat', load)).toBe('memory')
    })

    it('bounds entries and invalidates pending results safely', async () => {
        const cache = new PluginContextCache<string>(30_000, 1)
        const load = vi.fn(async () => 'memory')
        await cache.get('first', load)
        await cache.get('second', load)
        await cache.get('first', load)
        expect(load).toHaveBeenCalledTimes(3)
        let finish!: (value: string) => void
        const pending = cache.get('pending', () => new Promise<string>(resolve => { finish = resolve }))
        await Promise.resolve()
        cache.clear()
        expect(await cache.get('pending', load)).toBe('memory')
        finish('stale')
        await pending
        expect(await cache.get('pending', load)).toBe('memory')
    })
})
