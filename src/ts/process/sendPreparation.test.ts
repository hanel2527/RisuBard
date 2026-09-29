import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForSendSync } from './sendPreparation'

afterEach(() => vi.useRealTimers())

describe('send synchronization wait', () => {
    it('reports the current pending phase without cancelling the shared operation', async () => {
        vi.useFakeTimers()
        let message = 'sync', finish!: () => void
        const pending = new Promise<void>(resolve => { finish = resolve })
        const result = waitForSendSync(() => pending, { timeoutMs: 100, timeoutMessage: () => message }).catch(e => e.message)
        message = 'waiting for save'
        await vi.advanceTimersByTimeAsync(100)
        expect(await result).toBe('waiting for save')
        finish()
        await pending
        expect(vi.getTimerCount()).toBe(0)
    })
    it('times out without continuing generation when synchronization finishes late', async () => {
        vi.useFakeTimers()
        let finish!: () => void
        let generated = false
        const sync = new Promise<void>(resolve => { finish = resolve })
        const send = waitForSendSync(() => sync, { timeoutMs: 100, timeoutMessage: 'sync timed out' })
            .then(() => { generated = true })
        const rejected = expect(send).rejects.toThrow('sync timed out')
        await vi.advanceTimersByTimeAsync(100)
        await rejected
        finish()
        await Promise.resolve()
        expect(generated).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('allows cancellation while a shared synchronization is still running', async () => {
        vi.useFakeTimers()
        const controller = new AbortController()
        const wait = waitForSendSync(() => new Promise<void>(() => {}), { signal: controller.signal })
        const rejected = expect(wait).rejects.toMatchObject({name: 'AbortError'})
        controller.abort()
        await rejected
        expect(vi.getTimerCount()).toBe(0)
    })

    it('does not start synchronization after cancellation', async () => {
        const controller = new AbortController()
        controller.abort()
        let started = false
        await expect(waitForSendSync(async () => { started = true }, { signal: controller.signal }))
            .rejects.toMatchObject({name: 'AbortError'})
        expect(started).toBe(false)
    })

    it('propagates synchronization errors and clears its timer on success', async () => {
        vi.useFakeTimers()
        await expect(waitForSendSync(async () => { throw new Error('disk failure') }))
            .rejects.toThrow('disk failure')
        await waitForSendSync(async () => {})
        expect(vi.getTimerCount()).toBe(0)
    })
})
