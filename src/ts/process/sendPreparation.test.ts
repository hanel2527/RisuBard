import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForSendSync } from './sendPreparation'

afterEach(() => vi.useRealTimers())

describe('send synchronization wait', () => {
    it('waits for a slow synchronization without a time limit', async () => {
        vi.useFakeTimers()
        let finish!: () => void
        let generated = false
        const sync = new Promise<void>(resolve => { finish = resolve })
        const send = waitForSendSync(() => sync).then(() => { generated = true })
        await vi.advanceTimersByTimeAsync(600_000)
        expect(generated).toBe(false)
        finish()
        await send
        expect(generated).toBe(true)
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
