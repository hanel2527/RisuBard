import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findSingleProtonLink, downloadProtonModule } from './protonModule'

const mocks = vi.hoisted(() => ({ info: vi.fn(), auth: vi.fn(), root: vi.fn(), downloader: vi.fn(), node: vi.fn(), children: vi.fn() }))
vi.mock('./protonDriveClient', () => ({ createProtonDriveClient: () => ({ experimental: {
    getURLAccessInfo: mocks.info, authURLAccess: mocks.auth,
} }) }))
const link = 'https://drive.proton.me/urls/9E36DKPTV8#fCpP3alN4tsR'

describe('Realm Proton links', () => {
    it('deduplicates links across languages and ignores other sites', () => {
        expect(findSingleProtonLink(`[module](${link})\n${link}\nhttps://example.com`)).toBe(link)
        expect(findSingleProtonLink(`<a href="${link}">module</a>`)).toBe(link)
    })
    it('hides the action for missing, ambiguous, or lookalike links', () => {
        expect(findSingleProtonLink('no links')).toBeNull()
        expect(findSingleProtonLink(`${link} https://drive.proton.me/urls/OTHER#secret`)).toBeNull()
        expect(findSingleProtonLink('https://drive.proton.me.evil.test/urls/ABC#secret')).toBeNull()
        expect(findSingleProtonLink('https://drive.proton.me/urls/ABC')).toBeNull()
    })
})

describe('Proton module download', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        mocks.info.mockResolvedValue({ isCustomPasswordProtected: false, isLegacy: false })
        mocks.auth.mockResolvedValue({ getRootNode: mocks.root, getFileDownloader: mocks.downloader, getNode: mocks.node, iterateFolderChildren: mocks.children })
        mocks.root.mockResolvedValue({ uid: 'file', type: 'file', name: { ok: true, value: 'module.risum' } })
    })
    it.each([
        { type: 'file', name: { ok: true, value: 'readme.txt' } },
    ])('offers the original for unsupported roots without downloading', async root => {
        mocks.root.mockResolvedValue(root)
        expect(await downloadProtonModule(link)).toEqual({ kind: 'external', reason: 'unsupported' })
        expect(mocks.downloader).not.toHaveBeenCalled()
    })
    it('lists a shared folder without downloading files and distinguishes supported modules', async () => {
        mocks.root.mockResolvedValue({ uid: 'root', type: 'folder', name: { ok: true, value: 'Modules' } })
        mocks.children.mockImplementation(async function* () {
            yield { uid: 'a', type: 'file', name: { ok: true, value: 'A.RISUM' } }
            yield { uid: 'b', type: 'file', name: { ok: true, value: 'readme.txt' } }
            yield { uid: 'sub', type: 'folder', name: { ok: true, value: 'Older versions' } }
        })
        expect(await downloadProtonModule(link)).toEqual({ kind: 'folder', uid: 'root', name: 'Modules', entries: [
            { uid: 'sub', name: 'Older versions', type: 'folder', supported: true },
            { uid: 'a', name: 'A.RISUM', type: 'file', supported: true },
            { uid: 'b', name: 'readme.txt', type: 'file', supported: false },
        ] })
        expect(mocks.downloader).not.toHaveBeenCalled()
    })
    it('opens a selected nested folder, including an empty one', async () => {
        mocks.node.mockResolvedValue({ uid: 'sub', type: 'folder', name: { ok: true, value: 'Empty' } })
        mocks.children.mockImplementation(async function* () {})
        expect(await downloadProtonModule(link, { nodeUid: 'sub' })).toEqual({ kind: 'folder', uid: 'sub', name: 'Empty', entries: [] })
        expect(mocks.node).toHaveBeenCalledWith('sub')
        expect(mocks.downloader).not.toHaveBeenCalled()
    })
    it('downloads only the selected module and rejects unsupported selections', async () => {
        mocks.node.mockResolvedValue({ uid: 'selected', type: 'file', name: { ok: true, value: 'B.risum' } })
        mocks.downloader.mockResolvedValue({ getClaimedSizeInBytes: () => 1, downloadToStream: (stream: WritableStream) => ({
            completion: async () => { const writer = stream.getWriter(); await writer.write(new Uint8Array([7])); await writer.close() },
        }) })
        expect(await downloadProtonModule(link, { nodeUid: 'selected' })).toEqual({ kind: 'file', data: new Uint8Array([7]) })
        expect(mocks.downloader).toHaveBeenCalledWith('selected', undefined)
        mocks.downloader.mockClear()
        mocks.node.mockResolvedValue({ uid: 'text', type: 'file', name: { ok: true, value: 'readme.txt' } })
        expect(await downloadProtonModule(link, { nodeUid: 'text' })).toEqual({ kind: 'external', reason: 'unsupported' })
        expect(mocks.downloader).not.toHaveBeenCalled()
    })
    it('discards an interrupted folder listing', async () => {
        const controller = new AbortController()
        mocks.root.mockResolvedValue({ uid: 'root', type: 'folder', name: { ok: true, value: 'Modules' } })
        mocks.children.mockImplementation(async function* () { controller.abort(); yield { uid: 'a', type: 'file', name: { ok: true, value: 'a.risum' } } })
        await expect(downloadProtonModule(link, { signal: controller.signal })).rejects.toThrow()
        expect(mocks.downloader).not.toHaveBeenCalled()
    })
    it('offers the original for password-protected links', async () => {
        mocks.info.mockResolvedValue({ isCustomPasswordProtected: true })
        expect(await downloadProtonModule(link)).toEqual({ kind: 'external', reason: 'password' })
        expect(mocks.auth).not.toHaveBeenCalled()
    })
    it('collects verified bytes and reports download progress', async () => {
        mocks.downloader.mockResolvedValue({ getClaimedSizeInBytes: () => 4,
            downloadToStream: (stream: WritableStream) => ({
                completion: async () => { const w = stream.getWriter(); await w.write(new Uint8Array([111, 0, 1, 2])); await w.close() },
            }),
        })
        const progress = vi.fn()
        expect(await downloadProtonModule(link, { onProgress: progress })).toEqual({ kind: 'file', data: new Uint8Array([111, 0, 1, 2]) })
        expect(mocks.auth).toHaveBeenCalledWith(link, undefined, true)
        expect(progress).toHaveBeenCalledWith(4, 4)
    })
    it('rejects verification failures instead of importing partial bytes', async () => {
        mocks.downloader.mockResolvedValue({ getClaimedSizeInBytes: () => 4,
            downloadToStream: () => ({ completion: async () => { throw Error('signature failed') } }),
        })
        await expect(downloadProtonModule(link)).rejects.toThrow('signature failed')
    })
    it('does not contact Proton when already cancelled', async () => {
        const controller = new AbortController()
        controller.abort()
        await expect(downloadProtonModule(link, { signal: controller.signal })).rejects.toThrow()
        expect(mocks.info).not.toHaveBeenCalled()
    })
})
