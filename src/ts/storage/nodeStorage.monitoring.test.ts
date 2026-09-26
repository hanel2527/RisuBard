import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value, getDatabase: vi.fn() }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))

import { NodeStorage } from './nodeStorage'

const response = (enabled: boolean) => new Response(JSON.stringify({ enabled, defaultEnabled: false }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('monitoring server events', () => {
    it('authenticates the cookie and refreshes cached status directly from events', async () => {
        vi.useFakeTimers()
        let source!: EventTarget
        const close = vi.fn()
        vi.stubGlobal('EventSource', class extends EventTarget {
            close = close
            constructor() { super(); source = this }
        })
        const storage = new NodeStorage()
        const authFetch = vi.fn(async () => new Response('{}'))
        ;(storage as any).authFetch = authFetch
        const onChange = vi.fn()
        const unsubscribe = await storage.subscribeLiveFileChanges(onChange)
        await vi.advanceTimersByTimeAsync(0)
        expect(authFetch).toHaveBeenCalledWith('/api/session', { method: 'POST' })
        source.dispatchEvent(new MessageEvent('live-files', {
            data: '{"reason":"ready","enabled":false,"defaultEnabled":false}',
        }))
        expect(onChange).toHaveBeenCalledOnce()
        authFetch.mockClear()
        expect(await storage.syncLiveFiles('old')).toMatchObject({ enabled: false })
        expect(authFetch).not.toHaveBeenCalled()
        source.dispatchEvent(new MessageEvent('live-files', {
            data: '{"reason":"settings","enabled":true,"defaultEnabled":false}',
        }))
        await storage.syncLiveFiles('old')
        expect(authFetch).toHaveBeenLastCalledWith('/api/live-files/sync', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        })
        unsubscribe()
        expect(close).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('keeps newer event status when an earlier settings POST responds late', async () => {
        vi.useFakeTimers()
        let source!: EventTarget
        vi.stubGlobal('EventSource', class extends EventTarget {
            close() {}
            constructor() { super(); source = this }
        })
        const storage = new NodeStorage()
        let finishSet!: (response: Response) => void
        const authFetch = vi.fn().mockResolvedValueOnce(new Response('{}'))
            .mockImplementationOnce(() => new Promise<Response>(resolve => { finishSet = resolve }))
            .mockResolvedValueOnce(response(true))
        ;(storage as any).authFetch = authFetch
        const unsubscribe = await storage.subscribeLiveFileChanges(vi.fn())
        await vi.advanceTimersByTimeAsync(0)
        const pending = storage.setLiveFileMonitoring(false)
        source.dispatchEvent(new MessageEvent('live-files', {
            data: '{"reason":"settings","enabled":true,"defaultEnabled":true}',
        }))
        finishSet(response(false))
        expect(await pending).toMatchObject({ enabled: true })
        expect(await storage.getLiveFileMonitoring()).toMatchObject({ enabled: true })
        expect(authFetch).toHaveBeenLastCalledWith('/api/live-files/monitoring', { method: 'GET' })
        unsubscribe()
    })
})

describe('external file monitoring transport', () => {
    it('skips sync requests while disabled and checks status at most every 30 seconds', async () => {
        vi.useFakeTimers()
        const storage = new NodeStorage()
        const authFetch = vi.fn(async () => response(false))
        ;(storage as any).authFetch = authFetch

        expect(await storage.syncLiveFiles('old')).toMatchObject({ enabled: false })
        await storage.syncLiveFiles('old')
        expect(authFetch).toHaveBeenCalledTimes(1)
        expect(authFetch).toHaveBeenCalledWith('/api/live-files/monitoring', { method: 'GET' })
        vi.advanceTimersByTime(30_000)
        await storage.syncLiveFiles('old')
        expect(authFetch).toHaveBeenCalledTimes(2)
    })

    it('deduplicates simultaneous status reads and retries after a failed read', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockImplementation(async () => response(false))
        ;(storage as any).authFetch = authFetch
        const results = await Promise.allSettled([storage.getLiveFileMonitoring(), storage.getLiveFileMonitoring()])
        expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
        expect(authFetch).toHaveBeenCalledTimes(1)
        expect(await storage.getLiveFileMonitoring()).toMatchObject({ enabled: false })
        expect(authFetch).toHaveBeenCalledTimes(2)
    })

    it('discovers another tab enabling monitoring and fetches a fresh snapshot', async () => {
        vi.useFakeTimers()
        const storage = new NodeStorage()
        const authFetch = vi.fn().mockResolvedValueOnce(response(false))
            .mockResolvedValueOnce(response(true))
            .mockResolvedValueOnce(new Response('{"revision":"fresh","etag":null}'))
        ;(storage as any).authFetch = authFetch
        await storage.syncLiveFiles('old')
        vi.advanceTimersByTime(30_000)
        expect(await storage.syncLiveFiles('old')).toMatchObject({ revision: 'fresh' })
        expect(authFetch).toHaveBeenLastCalledWith('/api/live-files/sync', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        })
    })

    it('updates the cache immediately after toggling and requests a fresh snapshot on re-enable', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn(async (_path: string, init: RequestInit) => response(JSON.parse(String(init.body || '{}')).enabled ?? false))
        ;(storage as any).authFetch = authFetch
        await storage.getLiveFileMonitoring()
        await storage.setLiveFileMonitoring(true)
        await storage.syncLiveFiles('old')
        expect(authFetch).toHaveBeenLastCalledWith('/api/live-files/sync', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        })
        await storage.setLiveFileMonitoring(false)
        authFetch.mockClear()
        await storage.syncLiveFiles('old')
        expect(authFetch).not.toHaveBeenCalled()
    })

    it('keeps the previous setting when the server rejects a toggle', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn().mockResolvedValueOnce(response(false))
            .mockResolvedValueOnce(new Response('{"error":"Finish external editing first"}', { status: 409 }))
        ;(storage as any).authFetch = authFetch
        await storage.getLiveFileMonitoring()
        await expect(storage.setLiveFileMonitoring(true)).rejects.toThrow('Finish external editing first')
        expect(await storage.getLiveFileMonitoring()).toMatchObject({ enabled: false })
        await storage.syncLiveFiles('old')
        expect(authFetch).toHaveBeenCalledTimes(2)
    })

    it('does not let an earlier GET overwrite a successful toggle', async () => {
        const storage = new NodeStorage()
        let resolveGet!: (value: Response) => void
        const authFetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { resolveGet = resolve }))
            .mockResolvedValueOnce(response(false))
        ;(storage as any).authFetch = authFetch
        const pending = storage.getLiveFileMonitoring()
        await storage.setLiveFileMonitoring(false)
        resolveGet(response(true))
        await pending
        expect(await storage.getLiveFileMonitoring()).toMatchObject({ enabled: false })
    })

    it('does not let an earlier disabled sync overwrite a successful re-enable', async () => {
        const storage = new NodeStorage()
        let resolveSync!: (value: Response) => void
        const authFetch = vi.fn().mockResolvedValueOnce(response(true))
            .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveSync = resolve }))
            .mockResolvedValueOnce(response(true))
        ;(storage as any).authFetch = authFetch
        const pending = storage.syncLiveFiles('old')
        await vi.waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2))
        await storage.setLiveFileMonitoring(true)
        resolveSync(new Response('{"revision":"old","etag":null,"enabled":false}'))
        await pending
        expect(await storage.getLiveFileMonitoring()).toMatchObject({ enabled: true })
    })
})
