import { afterEach, expect, it, vi } from 'vitest'

const { createQueuedSaveDebounce } = require('./queued-save-debounce.cjs')
afterEach(() => vi.useRealTimers())

it('captures scope only inside the writer queue and ignores a timer already flushed', async () => {
    vi.useFakeTimers()
    const timers: Record<string, any> = {}
    const queued: (() => Promise<void>)[] = []
    const queue = (operation: () => Promise<void>) => { queued.push(operation); return Promise.resolve() }
    const write = vi.fn()
    const schedule = createQueuedSaveDebounce({ timers, queue, delay: 5, onError: vi.fn() })
    schedule('db', write)
    await vi.advanceTimersByTimeAsync(5)
    expect(write).not.toHaveBeenCalled()
    delete timers.db // a queued read/flush drained the pending save first
    await queued.shift()!()
    expect(write).not.toHaveBeenCalled()
    schedule('db', write)
    await vi.advanceTimersByTimeAsync(5)
    await queued.shift()!()
    expect(write).toHaveBeenCalledTimes(1)
    expect(timers.db).toBeUndefined()
})

it('does not run superseded callbacks or delete their replacement timer', async () => {
    vi.useFakeTimers()
    const timers: Record<string, any> = {}
    const queued: (() => Promise<void>)[] = []
    const queue = (operation: () => Promise<void>) => { queued.push(operation); return Promise.resolve() }
    const first = vi.fn()
    const second = vi.fn()
    const schedule = createQueuedSaveDebounce({ timers, queue, delay: 5, onError: vi.fn() })
    schedule('db', first)
    await vi.advanceTimersByTimeAsync(5)
    schedule('db', second)
    const replacement = timers.db
    await queued.shift()!()
    expect(first).not.toHaveBeenCalled()
    expect(timers.db).toBe(replacement)
    await vi.advanceTimersByTimeAsync(5)
    await queued.shift()!()
    expect(second).toHaveBeenCalledOnce()
})
