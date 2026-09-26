import { afterEach, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
const { createLiveFileEvents } = require('./live-file-events.cjs')

function client(hub: any) {
    const res = Object.assign(new EventEmitter(), {
        set: vi.fn(), setTimeout: vi.fn(), flushHeaders: vi.fn(),
        write: vi.fn((_text: string) => true), end: vi.fn(),
        destroyed: false, writableEnded: false,
    })
    hub.connect({ setTimeout: vi.fn() }, res)
    return res
}
function messages(res: ReturnType<typeof client>) {
    return res.write.mock.calls.map(call => String(call[0])).filter(text => text.startsWith('event:'))
        .map(text => JSON.parse(text.split('data: ')[1]))
}
afterEach(() => vi.useRealTimers())

test('connection gets current status and watcher bursts produce one content-free signal', () => {
    vi.useFakeTimers()
    const getStatus = vi.fn(() => ({ enabled: true, defaultEnabled: true }))
    const hub = createLiveFileEvents({ getStatus })
    const res = client(hub)
    expect(messages(res)).toEqual([{ enabled: true, defaultEnabled: true, reason: 'ready' }])
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ 'Content-Type': 'text/event-stream' }))
    hub.notify(); hub.notify(); hub.notify()
    vi.advanceTimersByTime(249)
    expect(messages(res)).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(messages(res)[1]).toEqual({ enabled: true, defaultEnabled: true, reason: 'change' })
    hub.close()
    expect(vi.getTimerCount()).toBe(0)
})

test('idle connections never trigger 750ms verification; disabled monitoring only keeps connection alive', () => {
    vi.useFakeTimers()
    let enabled = true
    const hub = createLiveFileEvents({ getStatus: () => ({ enabled, defaultEnabled: true }) })
    const res = client(hub)
    vi.advanceTimersByTime(59_999)
    expect(messages(res)).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(messages(res)[1].reason).toBe('verify')
    enabled = false
    hub.notify('settings')
    expect(messages(res).at(-1)).toEqual({ enabled: false, defaultEnabled: true, reason: 'settings' })
    hub.notify()
    vi.advanceTimersByTime(120_000)
    expect(messages(res)).toHaveLength(3)
    expect(res.write.mock.calls.some(call => String(call[0]).startsWith(': keepalive'))).toBe(true)
    hub.close()
})

test('closed or slow clients release all timers and cannot break healthy clients', () => {
    vi.useFakeTimers()
    const hub = createLiveFileEvents({ getStatus: () => ({ enabled: true, defaultEnabled: true }) })
    const slow = client(hub)
    const healthy = client(hub)
    slow.write.mockReturnValue(false)
    hub.notify('settings')
    expect(slow.end).toHaveBeenCalledOnce()
    expect(messages(healthy).at(-1).reason).toBe('settings')
    healthy.emit('close')
    expect(vi.getTimerCount()).toBe(0)
    hub.notify()
    expect(vi.getTimerCount()).toBe(0)
    const reconnect = client(hub)
    expect(messages(reconnect)[0].reason).toBe('ready')
    hub.close()
})
