import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPainterReference } from './reference'

const mocks = vi.hoisted(() => ({ meta: vi.fn(), record: vi.fn(), asset: vi.fn(), metadata: vi.fn() }))
vi.mock('../process/files/inlayMeta', () => ({ getInlayMeta: mocks.meta }))
vi.mock('../process/files/inlays', () => ({ getInlayAssetBlob: mocks.asset }))
vi.mock('./gallery', async original => ({ ...await original<any>(), loadPainterGalleryRecord: mocks.record }))
vi.mock('../storage/nodeStorage', () => ({ NodeStorage: class {} }))
vi.mock('./metadata', () => ({ readPainterImageMetadata: mocks.metadata }))

beforeEach(() => {
    vi.clearAllMocks()
    mocks.meta.mockResolvedValue({ charId: 'bot', chatId: 'deleted-chat' })
    mocks.record.mockResolvedValue(null)
    mocks.asset.mockResolvedValue({ type: 'image', data: new Blob(['synthetic']) })
    mocks.metadata.mockReturnValue({})
})

describe('BardPainter gallery reference', () => {
    it('rejects another bot or an asset without ownership before reading prompts or original pixels', async () => {
        mocks.meta.mockResolvedValueOnce({ charId: 'other' }).mockResolvedValueOnce(null)
        expect(await loadPainterReference('image', 'bot')).toBeNull()
        expect(await loadPainterReference('image', 'bot')).toBeNull()
        expect(mocks.record).not.toHaveBeenCalled()
        expect(mocks.asset).not.toHaveBeenCalled()
    })
    it('reads preserved prompts from deleted chats and omits the old pose and scene', async () => {
        mocks.record.mockResolvedValue({ result: { draft: { scene: 'old scene', subjects: [{ name: '인물', appearance: 'brown hair', clothing: 'gray coat', state: 'wet', pose: 'running' }] } } })
        expect(JSON.parse((await loadPainterReference('image', 'bot'))!)).toEqual({ characters: [{ name: '인물', prompt: 'brown hair\n\ngray coat' }] })
        expect(mocks.asset).not.toHaveBeenCalled()
    })
    it('respects direct prompt edits instead of stale appearance and clothing fields', async () => {
        mocks.record.mockResolvedValue({ result: { draft: { subjects: [{ name: '인물', prompt: 'silver hair\n\nblue jacket\n\nsmiling', appearance: 'old hair', clothing: 'old outfit' }] } } })
        const reference = (await loadPainterReference('image', 'bot'))!
        expect(reference).toContain('silver hair')
        expect(reference).toContain('blue jacket')
        expect(reference).not.toMatch(/old|smiling/)
    })
    it('falls back to embedded NovelAI character captions and excludes negative blocks', async () => {
        mocks.metadata.mockReturnValue({ Comment: JSON.stringify({ v4_prompt: { caption: { base_caption: 'old scene', char_captions: [{ char_caption: 'green coat' }] } }, uc: 'blur' }) })
        const reference = (await loadPainterReference('image', 'bot'))!
        expect(reference).toContain('green coat')
        expect(reference).not.toMatch(/blur|old scene/)
    })
    it('returns null for images without generation information', async () => {
        expect(await loadPainterReference('image', 'bot')).toBeNull()
    })
})
