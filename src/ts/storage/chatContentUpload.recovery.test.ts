import { afterEach, expect, it, vi } from 'vitest'
import { uploadChatContent } from './chatContentUpload'
afterEach(() => vi.useRealTimers())

it('returns the original failed upload response when cleanup never responds', async () => {
    vi.useFakeTimers()
    let cleanupSignal!: AbortSignal
    const failed = new Response('conflict', { status: 409 })
    const request = vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === 'POST') return failed
        cleanupSignal = init.signal!
        return new Promise<Response>(() => {})
    })
    const upload = uploadChatContent(request, 'character', 0, 'chat', new Uint8Array(1024 * 1024 + 1), 1, true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await upload).toBe(failed)
    expect(cleanupSignal.aborted).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
})
