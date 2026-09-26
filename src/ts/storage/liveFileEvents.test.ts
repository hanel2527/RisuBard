import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeLiveFileEvents } from './liveFileEvents'

class FakeEventSource extends EventTarget {
    static instances: FakeEventSource[] = []
    close = vi.fn()
    constructor(public url: string) { super(); FakeEventSource.instances.push(this) }
    message(reason = 'ready', enabled = true) {
        this.dispatchEvent(new MessageEvent('live-files', { data: JSON.stringify({ reason, enabled, defaultEnabled: true }) }))
    }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); FakeEventSource.instances = [] })

describe('live file event subscription', () => {
    it('uses server events without idle polling and closes listeners/timer', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('EventSource', FakeEventSource)
        const authenticate = vi.fn(async () => {})
        const onEvent = vi.fn(), onFallback = vi.fn()
        const close = subscribeLiveFileEvents({ authenticate, onEvent, onFallback })
        await vi.advanceTimersByTimeAsync(0)
        const source = FakeEventSource.instances[0]
        expect(source.url).toBe('/api/live-files/events')
        source.message()
        source.message('change')
        expect(onEvent).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(180_000)
        expect(authenticate).toHaveBeenCalledTimes(1)
        expect(onFallback).not.toHaveBeenCalled()
        close()
        source.message()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(onEvent).toHaveBeenCalledTimes(2)
        expect(source.close).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('falls back once per minute without EventSource', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('EventSource', undefined)
        const onFallback = vi.fn()
        const close = subscribeLiveFileEvents({ authenticate: vi.fn(), onEvent: vi.fn(), onFallback })
        expect(onFallback).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(59_999)
        expect(onFallback).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(onFallback).toHaveBeenCalledTimes(2)
        close()
    })

    it('refreshes cookie auth after a long disconnect without duplicating connections', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('EventSource', FakeEventSource)
        const authenticate = vi.fn(async () => {})
        const onFallback = vi.fn()
        const close = subscribeLiveFileEvents({ authenticate, onEvent: vi.fn(), onFallback })
        await vi.advanceTimersByTimeAsync(0)
        const source = FakeEventSource.instances[0]
        source.message()
        source.dispatchEvent(new Event('error'))
        await vi.advanceTimersByTimeAsync(59_999)
        expect(authenticate).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(authenticate).toHaveBeenCalledTimes(2)
        expect(source.close).toHaveBeenCalledOnce()
        expect(onFallback).toHaveBeenCalledOnce()
        FakeEventSource.instances[1].message()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(authenticate).toHaveBeenCalledTimes(2)
        close()
    })

    it('retries initial authentication failure and cannot open after cleanup', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('EventSource', FakeEventSource)
        let finishAuth!: () => void
        const authenticate = vi.fn().mockRejectedValueOnce(new Error('offline'))
            .mockImplementationOnce(() => new Promise<void>(resolve => { finishAuth = resolve }))
        const onFallback = vi.fn()
        const close = subscribeLiveFileEvents({ authenticate, onEvent: vi.fn(), onFallback })
        await vi.advanceTimersByTimeAsync(0)
        expect(onFallback).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(authenticate).toHaveBeenCalledTimes(2)
        close()
        finishAuth()
        await vi.advanceTimersByTimeAsync(0)
        expect(FakeEventSource.instances).toHaveLength(0)
        expect(vi.getTimerCount()).toBe(0)
    })
})
