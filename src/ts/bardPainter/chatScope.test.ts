import { describe, expect, it } from 'vitest'
import { rebindPainterChatScope } from './chatScope'
import { createPainterChatData, createPainterSettings, type PainterResult } from './types'

function fixture() {
    const data = createPainterChatData()
    const anchor = { characterId: 'original-bot', chatId: 'original-chat', messageId: 'same-message', start: 7, end: 18, text: 'hello world' }
    data.anchor = { ...anchor }
    data.draft = { rendering: 'watercolor', scene: 'garden', negative: '', subjects: [] }
    data.outfits = [{ id: 'local-outfit', subjectId: 'aria', name: 'Travel', clothing: 'white shirt', state: '' }]
    const complete: PainterResult = {
        id: 'complete', assetId: 'shared-complete-webp', createdAt: 1, anchor: { ...anchor },
        draft: { ...data.draft }, settings: createPainterSettings(), seed: 42,
        style: { id: 'custom', name: 'Style', artist: '', rendering: 'watercolor', negative: '', steps: 28, scale: 6, cfgRescale: 0, sampler: 'k_euler' },
    }
    data.results = [complete, { ...complete, id: 'pending', assetId: 'original-pending-png', anchor: { ...anchor }, compressionPending: true }]
    return { id: 'original-chat', bardPainter: data }
}

describe('BardPainter copied and imported chat scope', () => {
    it('rebinds completed results and the editable draft to the new owner while retaining message offsets', () => {
        const original = fixture()
        const copied = structuredClone(original)
        copied.id = 'copied-chat'
        rebindPainterChatScope(copied, 'destination-bot')
        expect(copied.bardPainter.anchor).toEqual({
            characterId: 'destination-bot', chatId: 'copied-chat', messageId: 'same-message', start: 7, end: 18, text: 'hello world',
        })
        expect(copied.bardPainter.results).toEqual([{ ...original.bardPainter.results[0], anchor: copied.bardPainter.anchor }])
        expect(copied.bardPainter.draft).toEqual(original.bardPainter.draft)
        expect(copied.bardPainter.outfits).toEqual(original.bardPainter.outfits)
        expect(original.bardPainter.results).toHaveLength(2)
        expect(original.bardPainter.anchor.chatId).toBe('original-chat')
    })

    it('drops only incomplete compression jobs and clears a reference to an omitted job', () => {
        const copied = fixture()
        copied.id = 'new-chat'
        copied.bardPainter.settings.context.referenceId = 'pending'
        rebindPainterChatScope(copied, 'new-bot')
        expect(copied.bardPainter.results.map(result => result.assetId)).toEqual(['shared-complete-webp'])
        expect(copied.bardPainter.settings.context.referenceId).toBe('')
        copied.bardPainter.settings.context.referenceId = 'complete'
        rebindPainterChatScope(copied, 'new-bot')
        expect(copied.bardPainter.settings.context.referenceId).toBe('complete')
    })

    it('does not add painter data to ordinary chats', () => {
        const ordinary = { id: 'ordinary-chat' }
        rebindPainterChatScope(ordinary, 'destination-bot')
        expect(ordinary).toEqual({ id: 'ordinary-chat' })
    })
})
