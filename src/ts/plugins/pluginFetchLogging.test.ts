import { describe, expect, it, vi } from 'vitest'
import { createPluginFetchLogging } from './pluginFetchLogging'

describe('plugin HTTP log classification', () => {
    it('tags both plugin transports while preserving bodies and caller options', async () => {
        const nativeFetch = vi.fn().mockResolvedValue('native')
        const risuFetch = vi.fn().mockResolvedValue('legacy')
        const api = createPluginFetchLogging('provider-manager', { nativeFetch, risuFetch })
        const options = { method: 'POST' as const, body: '{"prompt":"hello"}', headers: { 'X-Test': 'yes' } }
        expect(await api.nativeFetch('https://example.test', options)).toBe('native')
        expect(await api.risuFetch('https://example.test', options)).toBe('legacy')
        for (const transport of [nativeFetch, risuFetch]) {
            expect(transport).toHaveBeenCalledWith('https://example.test', { ...options, logCategory: 'other', logSource: 'plugin', logModel: 'provider-manager' })
        }
        expect(options).not.toHaveProperty('logCategory')
        await api.nativeFetch('https://example.test', { ...options, logCategory: 'llm', logModel: 'custom' })
        expect(nativeFetch.mock.calls.at(-1)?.[1]).toMatchObject({ logCategory: 'llm', logModel: 'custom' })
    })
})
