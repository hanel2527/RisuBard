import { describe, expect, test } from 'vitest'
import {
    OLLAMA_CLOUD_MAX_IN_FLIGHT,
    OllamaCloudRequestLimiter,
} from './ollamaCloudLimiter'

describe('OllamaCloudRequestLimiter', () => {
    test('admits three requests and releases queued requests in FIFO order', async () => {
        const limiter = new OllamaCloudRequestLimiter()
        const releases = await Promise.all([
            limiter.acquire(),
            limiter.acquire(),
            limiter.acquire(),
        ])
        expect(limiter.activeCount).toBe(OLLAMA_CLOUD_MAX_IN_FLIGHT)

        const fourth = limiter.acquire()
        const fifth = limiter.acquire()
        expect(limiter.queuedCount).toBe(2)

        releases[1]()
        const releaseFourth = await fourth
        expect(limiter.activeCount).toBe(OLLAMA_CLOUD_MAX_IN_FLIGHT)
        expect(limiter.queuedCount).toBe(1)

        releases[0]()
        const releaseFifth = await fifth
        expect(limiter.activeCount).toBe(OLLAMA_CLOUD_MAX_IN_FLIGHT)

        releases[2]()
        releaseFourth()
        releaseFifth()
        expect(limiter.activeCount).toBe(0)
    })

    test('aborting a queued request rejects it without blocking the next waiter', async () => {
        const limiter = new OllamaCloudRequestLimiter()
        const releases = await Promise.all([
            limiter.acquire(),
            limiter.acquire(),
            limiter.acquire(),
        ])
        const controller = new AbortController()
        const aborted = limiter.acquire(controller.signal)
        const next = limiter.acquire()

        controller.abort()
        await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
        expect(limiter.queuedCount).toBe(1)

        releases[0]()
        const releaseNext = await next
        releaseNext()
        releases[1]()
        releases[2]()
        expect(limiter.activeCount).toBe(0)
    })

    test('release is idempotent after a transport error', async () => {
        const limiter = new OllamaCloudRequestLimiter()
        const release = await limiter.acquire()
        release()
        release()
        expect(limiter.activeCount).toBe(0)
        const next = await limiter.acquire()
        next()
        expect(limiter.activeCount).toBe(0)
    })
})
