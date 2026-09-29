import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('src/lang', () => ({ language: { storageConnectionTimeout: 'connection timeout', storageWriteTimeout: 'write timeout' } }))
vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./database.svelte', () => ({ normalizeChat: (v: unknown) => v, getDatabase: () => ({}) }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: () => new Uint8Array([1]) }))
import { NodeStorage } from './nodeStorage'

beforeEach(() => {
    vi.useFakeTimers()
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
})
afterEach(() => {
    ;(NodeStorage as any).sessionInitialized = false
    ;(NodeStorage as any).sessionPending = null
    vi.useRealTimers(); vi.unstubAllGlobals()
})

it.each(['CANONICAL_FILES_CHANGED', 'EXTERNAL_EDIT_MODE'])('preserves %s through the bounded save transport', async code => {
    const storage = new NodeStorage()
    ;(storage as any).authFetch = vi.fn(async () => Response.json({code, error: 'conflict', currentEtag: 'new'}, {status: 409}))
    await expect(storage.saveChatContent('c', 0, 'chat', {})).rejects.toMatchObject({
        currentEtag: 'new', canonicalFilesChanged: code === 'CANONICAL_FILES_CHANGED',
        externalEditMode: code === 'EXTERNAL_EDIT_MODE',
    })
    expect(storage.pendingSaveRequests).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
})

it('releases a stalled shared token refresh and ignores its late body', async () => {
    const storage = new NodeStorage()
    let release!: (v: any) => void
    const fetch = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
        release = value => { controller.enqueue(new Uint8Array(value)); controller.close() }
    } })))
        .mockResolvedValueOnce(Response.json({ token: 'new' }))
    vi.stubGlobal('fetch', fetch)
    const first = storage.createAuth().catch(e => e.code)
    const concurrent = storage.createAuth().catch(e => e.code)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await first).toBe('STORAGE_CONNECTION_TIMEOUT')
    expect(await concurrent).toBe('STORAGE_CONNECTION_TIMEOUT')
    expect(await storage.createAuth()).toBe('new')
    release(new TextEncoder().encode('{"token":"old"}').buffer)
    await vi.advanceTimersByTimeAsync(0)
    expect(await storage.createAuth()).toBe('new')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
})

it('retries session initialization after a stalled request', async () => {
    ;(NodeStorage as any).sessionInitialized = false
    const storage = new NodeStorage()
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    let release!: (v: Response) => void
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
        .mockResolvedValueOnce(Response.json({}))
    vi.stubGlobal('fetch', fetch)
    const first = (storage as any).initSession()
    await vi.advanceTimersByTimeAsync(8_000)
    await first
    expect((NodeStorage as any).sessionPending).toBeNull()
    expect((NodeStorage as any).sessionInitialized).toBe(false)
    await (storage as any).initSession()
    expect((NodeStorage as any).sessionInitialized).toBe(true)
    release(Response.json({}))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
})

it.each(['chat', 'patch', 'database'])('bounds a stalled %s save response without retrying or accepting a late acknowledgement', async kind => {
    const storage = new NodeStorage()
    storage.setDbEtag('before')
    let release!: (v: Response) => void
    const request = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
    ;(storage as any).authFetch = request
    const save = (kind === 'chat' ? storage.saveChatContent('c', 0, 'chat', {})
        : kind === 'patch' ? storage.patchItem('database/database.bin', { patch: [], expectedHash: 'before' })
        : storage.setItem('database/database.bin', new Uint8Array([1]), 'before')).catch(e => e.code)
    expect(storage.pendingSaveRequests).toBe(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await save).toBe('STORAGE_WRITE_TIMEOUT')
    expect(storage.pendingSaveRequests).toBe(0)
    expect(request).toHaveBeenCalledTimes(1)
    release(Response.json({ success: true, etag: 'late' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(storage._lastDbEtag).toBe('before')
})
