import { beforeEach, describe, expect, it, vi } from 'vitest'
import { filterPainterGallery, loadPainterGalleryRecord, novelAiGalleryInfo, preservePainterChatGallery, savePainterGalleryRecord } from './gallery'
import { createPainterSettings, type PainterResult } from './types'
import type { InlayExplorerItem } from '../process/files/inlays'

const storage = vi.hoisted(() => new Map<string, Uint8Array>())
vi.mock('../storage/nodeStorage', () => ({ NodeStorage: class {
    async getItem(key: string) { return storage.get(key) }
    async setItem(key: string, data: Uint8Array) { storage.set(key, data) }
    async keys(prefix: string) { return [...storage.keys()].filter(key => key.startsWith(prefix)) }
} }))
const result = (): PainterResult => ({ id: 'generation', assetId: 'image', createdAt: 1, seed: 9,
    anchor: { characterId: 'bot', chatId: 'chat', messageId: 'message', start: 0, end: 1, text: 'A' },
    draft: { rendering: '', scene: 'quiet room', negative: '', subjects: [] },
    style: { id: 'default', name: '기본', artist: '', rendering: '', negative: '', steps: 28, scale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral' }, settings: createPainterSettings() })
const item = (id: string, chatId: string | undefined, createdAt: number, charId = 'bot'): InlayExplorerItem => ({ id, meta: { charId, chatId, createdAt, updatedAt: createdAt }, hasMeta: true, type: 'image', name: id, ext: 'webp' })

beforeEach(() => storage.clear())
describe('BardPainter asset gallery', () => {
    it('preserves generation details independently of the source chat', async () => {
        const chat = { name: '예시 챗', bardPainter: { results: [result()] } } as any
        storage.set('inlay/image', new Uint8Array([1]))
        await preservePainterChatGallery(chat)
        delete chat.bardPainter
        expect((await loadPainterGalleryRecord('image'))?.result.seed).toBe(9)
        expect((await loadPainterGalleryRecord('image'))?.chatName).toBe('예시 챗')
    })
    it('does not replace saved generation data with a subsequently modified legacy result', async () => {
        await savePainterGalleryRecord(result(), '원래 챗')
        await preservePainterChatGallery({ name: '수정', bardPainter: { results: [{ ...result(), seed: 100 }] } } as any)
        expect((await loadPainterGalleryRecord('image'))?.result.seed).toBe(9)
    })
    it('does not recreate generation records for images already deleted from the gallery', async () => {
        await preservePainterChatGallery({ name: '예시 챗', bardPainter: { results: [result()] } } as any)
        expect(await loadPainterGalleryRecord('image')).toBeNull()
    })
    it('groups missing chats together, retains unassigned images and sorts by generation time', () => {
        const items = [item('old', 'gone1', 2), item('current', 'live', 4), item('new', 'gone2', 5), item('unassigned', undefined, 6), item('other', 'gone', 9, 'otherbot')]
        expect(filterPainterGallery(items, 'bot', [{ id: 'live' }]).map(i => i.id)).toEqual(['unassigned', 'new', 'current', 'old'])
        expect(filterPainterGallery(items, 'bot', [{ id: 'live' }], '__deleted__').map(i => i.id)).toEqual(['new', 'old'])
        expect(filterPainterGallery(items, 'bot', [{ id: 'live' }], 'live').map(i => i.id)).toEqual(['current'])
    })
    it('extracts NovelAI main, character and negative blocks without credentials', () => {
        const info = novelAiGalleryInfo({ Comment: JSON.stringify({ seed: 42, token: 'private', v4_prompt: { caption: { base_caption: 'room', char_captions: [{ char_caption: 'blue coat' }] } }, v4_negative_prompt: { caption: { base_caption: 'blur', char_captions: [{ char_caption: 'hat' }] } } }) })
        expect(info?.blocks.map(b => b.text)).toEqual(['room', 'blue coat', 'hat', 'blur'])
        expect(JSON.stringify(info)).not.toContain('private')
        expect(info?.settings).toContainEqual(['시드', '42'])
    })
    it('extracts request metadata and ignores images without prompt metadata', () => {
        expect(novelAiGalleryInfo({ input: 'garden', model: 'nai-diffusion-5-full', parameters: { seed: 1 } })?.blocks[0].text).toBe('garden')
        expect(novelAiGalleryInfo({ Software: 'Camera' })).toBeNull()
    })
})
