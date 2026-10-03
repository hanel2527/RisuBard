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

it.each(['cleanup', 'prepare'])('shows the server reason for failed import rollback %s', async action => {
    const storage = new NodeStorage()
    ;(storage as any).authFetch = vi.fn(async () => Response.json({ error: 'Plugin storage unavailable during asset cleanup' }, { status: 500 }))
    const request = action === 'cleanup' ? storage.cleanupImportAssets(['assets/new.png'], 'id') : storage.prepareImportRollback('id')
    await expect(request).rejects.toThrow('Plugin storage unavailable during asset cleanup')
})

it.each(['cleanup', 'prepare'])('waits for a stalled import rollback %s response without a time limit', async action => {
    const storage = new NodeStorage()
    ;(storage as any).authFetch = vi.fn(() => new Promise(() => {}))
    let settled = false
    void (action === 'cleanup' ? storage.cleanupImportAssets([], 'id') : storage.prepareImportRollback('id')).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(settled).toBe(false)
    expect(storage.pendingSaveRequests).toBe(1)
})

it('keeps the HTTP status when the rollback error body is not JSON', async () => {
    const storage = new NodeStorage()
    ;(storage as any).authFetch = vi.fn(async () => new Response('<html>proxy failure</html>', { status: 502 }))
    await expect(storage.cleanupImportAssets([], 'id')).rejects.toThrow('Import rollback failed (502)')
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

it('waits for a slow shared token refresh without a time limit', async () => {
    const storage = new NodeStorage()
    let release!: (v: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
    vi.stubGlobal('fetch', fetch)
    const first = storage.createAuth()
    const concurrent = storage.createAuth()
    await vi.advanceTimersByTimeAsync(600_000)
    release(Response.json({ token: 'late' }))
    expect(await first).toBe('late')
    expect(await concurrent).toBe('late')
    expect(fetch).toHaveBeenCalledOnce()
})

it('keeps using a still-valid token when its renewal stalls', async () => {
    const storage = new NodeStorage()
    // Every renewal after the first stalls behind other connections.
    const fetch = vi.fn().mockImplementation(() => new Promise(() => {}))
        .mockResolvedValueOnce(Response.json({ token: 'current' }))
    vi.stubGlobal('fetch', fetch)
    expect(await storage.createAuth()).toBe('current')
    // Inside the renewal window callers get the current token without waiting.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
    expect(await storage.createAuth()).toBe('current')
    expect(fetch.mock.calls.length).toBeGreaterThan(1)
    // Stalled renewals time out without breaking the still-valid session.
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await storage.createAuth()).toBe('current')
})

it('waits for a slow session initialization without a time limit', async () => {
    ;(NodeStorage as any).sessionInitialized = false
    const storage = new NodeStorage()
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    let release!: (v: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { release = resolve })))
    const init = (storage as any).initSession()
    await vi.advanceTimersByTimeAsync(600_000)
    expect((NodeStorage as any).sessionInitialized).toBe(false)
    release(Response.json({}))
    await init
    expect((NodeStorage as any).sessionInitialized).toBe(true)
})

it.each(['chat', 'patch', 'database'])('waits for a slow %s save response without a time limit or retry', async kind => {
    const storage = new NodeStorage()
    storage.setDbEtag('before')
    const request = vi.fn(() => new Promise<Response>(() => {}))
    ;(storage as any).authFetch = request
    let settled = false
    void (kind === 'chat' ? storage.saveChatContent('c', 0, 'chat', {})
        : kind === 'patch' ? storage.patchItem('database/database.bin', { patch: [], expectedHash: 'before' })
        : storage.setItem('database/database.bin', new Uint8Array([1]), 'before')).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(settled).toBe(false)
    expect(storage.pendingSaveRequests).toBe(1)
    expect(request).toHaveBeenCalledTimes(1)
})
