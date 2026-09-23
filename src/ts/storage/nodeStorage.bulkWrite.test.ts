import { describe, expect, it, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('src/ts/stores.svelte', () => ({
    selIdState: { selId: 0 },
    DBState: { db: { characters: [] } },
}))
vi.mock('./database.svelte', () => ({
    normalizeChat: (value: unknown) => value,
    getCurrentChat: () => null,
    getCurrentCharacter: () => null,
    getDatabase: () => ({
        modules: [], enabledModules: [], personas: [], selectedPersona: 0,
        personaEnabledModules: {}, characters: [],
    }),
}))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./chatContentPage', () => ({ assembleChatContentPages: vi.fn() }))

import { NodeStorage } from './nodeStorage'

describe('NodeStorage live file synchronization', () => {
    it('sends the revision through authenticated transport without advancing the save etag', async () => {
        const storage = new NodeStorage()
        storage.setDbEtag('acknowledged')
        const result = { revision: 'new', etag: 'remote', snapshot: { characters: [], loreBook: [] } }
        const authFetch = vi.fn(async () => new Response(JSON.stringify(result), { status: 200 }))
        ;(storage as any).authFetch = authFetch
        expect(await storage.syncLiveFiles('old')).toEqual(result)
        expect(authFetch).toHaveBeenCalledWith('/api/live-files/sync', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"revision":"old"}',
        })
        expect(storage._lastDbEtag).toBe('acknowledged')
    })

    it('rejects a failed sync instead of accepting a partial response', async () => {
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async () => new Response('{"error":"writer busy"}', { status: 423 }))
        await expect(storage.syncLiveFiles()).rejects.toThrow('writer busy')
    })

    it('preserves the inactive code so background polling can stay quiet while send preflight still rejects', async () => {
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async () => new Response(
            '{"code":"LIVE_FILES_INACTIVE","error":"writer inactive"}', { status: 409 },
        ))
        await expect(storage.syncLiveFiles()).rejects.toMatchObject({ code: 'LIVE_FILES_INACTIVE' })
    })
})

describe('NodeStorage bulk asset writes', () => {
    it('sends up to 200 small assets per request', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ))
        ;(storage as any).authFetch = authFetch
        const entries = Array.from({ length: 201 }, (_, index) => ({
            key: `assets/${index}`,
            value: Uint8Array.of(index % 256),
        }))

        await storage.setItems(entries)

        expect(authFetch).toHaveBeenCalledTimes(2)
        expect(JSON.parse(String(authFetch.mock.calls[0]?.[1]?.body))).toHaveLength(200)
        expect(JSON.parse(String(authFetch.mock.calls[1]?.[1]?.body))).toHaveLength(1)
    })
})
