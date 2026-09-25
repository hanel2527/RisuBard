import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import { createPainterChatData } from 'src/ts/bardPainter/types'
import { painterTestState } from './BardPainterTestState.svelte'
import BardPainterReference from './BardPainterReference.svelte'

let component: ReturnType<typeof createClassComponent> | undefined
let session: any
async function mount(disabled = false) {
    component = createClassComponent({ component: BardPainterReference, target: document.body, props: { session, disabled } })
    await tick()
}
const clear = () => document.querySelector<HTMLButtonElement>('[data-painter-reference] button')!
beforeEach(() => {
    session = painterTestState({ characterId: 'bot', chatId: 'chat', data: createPainterChatData(), state: { status: 'idle', error: '' }, setReference: vi.fn().mockResolvedValue(true) })
})
afterEach(() => { component?.$destroy(); component = undefined; document.body.replaceChildren() })

describe('BardPainter reference slot', () => {
    it('shows the gallery location without an inline list or a selection control', async () => {
        await mount()
        expect(document.body.textContent).toContain('캐릭터 디스플레이')
        expect(document.body.textContent).toContain('참고 삽화 지정')
        expect(document.querySelector('[aria-expanded]')).toBeNull()
        expect(document.querySelector('[data-painter-gallery]')).toBeNull()
        expect(document.querySelector('button')).toBeNull()
    })
    it('shows a legacy selection and exposes only the clear action', async () => {
        session.data.settings.context.referenceId = 'old-result'
        session.data.results = [{ id: 'old-result', assetId: 'old-image' }]
        await mount()
        expect(document.querySelector('img')?.src).toContain(Buffer.from('inlay_thumb/old-image').toString('hex'))
        expect(document.querySelectorAll('button')).toHaveLength(1)
        expect(clear().textContent).toContain('비우기')
        clear().click(); await tick()
        expect(session.setReference).toHaveBeenCalledWith('')
    })
    it('reflects a reference assigned elsewhere and clears it through the session', async () => {
        await mount()
        session.data.settings.context.referenceAssetId = 'gallery-image'
        await tick()
        expect(document.querySelector('img')).not.toBeNull()
        session.setReference.mockImplementation(async () => { session.data.settings.context.referenceAssetId = ''; return true })
        clear().click(); await tick(); await tick()
        expect(document.querySelector('img')).toBeNull()
        expect(document.body.textContent).toContain('선택하지 않음')
    })
    it('keeps a failed clear visible and prevents clearing during another operation', async () => {
        session.data.settings.context.referenceAssetId = 'old-image'
        session.setReference.mockImplementation(async () => { session.state.error = '저장 실패'; return false })
        await mount()
        clear().click(); await tick(); await tick()
        expect(session.data.settings.context.referenceAssetId).toBe('old-image')
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('저장 실패')
        session.state.status = 'saving'; await tick()
        expect(clear().disabled).toBe(true)
    })
})
