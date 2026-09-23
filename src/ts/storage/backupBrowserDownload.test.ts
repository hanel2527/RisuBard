import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./database.svelte', () => ({ normalizeChat: vi.fn(), getDatabase: vi.fn() }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))

import { NodeStorage } from './nodeStorage'

describe('backup transfer handoff', () => {
    let storage: NodeStorage
    let authFetch: ReturnType<typeof vi.fn>
    let links: HTMLAnchorElement[]

    beforeEach(() => {
        storage = new NodeStorage()
        authFetch = vi.fn(async () => new Response('{"ok":true}'))
        ;(storage as any).authFetch = authFetch
        links = []
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            links.push(this)
        })
    })
    afterEach(() => { vi.restoreAllMocks() })

    it.each([
        [undefined, '/api/backup/export'],
        [{ target: 'upstream' as const }, '/api/backup/export?target=upstream'],
        [{ mode: 'settings' as const, moduleAssets: false }, '/api/backup/export?mode=settings&moduleAssets=0'],
    ])('hands off export %j without fetching backup bytes into the tab', async (options, url) => {
        await storage.exportBackup(options)
        expect(authFetch).toHaveBeenCalledExactlyOnceWith('/api/session', { method: 'POST' })
        expect(links).toHaveLength(1)
        expect(links[0].getAttribute('href')).toBe(url)
        expect(links[0].hasAttribute('download')).toBe(true)
        expect(links[0].isConnected).toBe(false)
    })

    it('refreshes the cookie for every handoff, including an existing backup', async () => {
        await storage.exportBackup()
        await storage.downloadServerBackup('risu-backup-123.bin')
        expect(authFetch).toHaveBeenCalledTimes(2)
        expect(links[1].getAttribute('href')).toBe('/api/backup/server/download/risu-backup-123.bin')
    })

    it('does not start a download if authentication fails', async () => {
        authFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }))
        await expect(storage.exportBackup()).rejects.toThrow()
        expect(links).toHaveLength(0)
    })
})
