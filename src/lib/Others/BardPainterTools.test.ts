import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { tick } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import { createPainterChatData } from 'src/ts/bardPainter/types'
import { painterTestState } from './BardPainterTestState.svelte'
import BardPainterTools from './BardPainterTools.svelte'

let component: ReturnType<typeof createClassComponent> | undefined
let session: any
let onClose = vi.fn<() => void>()
async function mount(mode: 'style' | 'characters' | 'settings' | null, disabled = false) {
    component = createClassComponent({ component: BardPainterTools, target: document.body, props: { session, mode, onClose, disabled } })
    await tick()
}
function button(label: string) {
    const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
    expect(result, label).toBeDefined()
    return result!
}
async function change(label: string, value: string) {
    const field = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)
    expect(field, label).not.toBeNull()
    field!.value = value
    field!.dispatchEvent(new Event('input', { bubbles: true }))
    field!.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
}
beforeEach(() => {
    onClose = vi.fn<() => void>()
    const style = { id: 'default', name: '기본', artist: '', rendering: '', negative: '', steps: 28, scale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral' }
    const data = createPainterChatData()
    session = painterTestState({
        data, styles: [style], style,
        bot: { identities: [{ id: 'example', name: '예시 인물', aliases: [], appearance: '' }], outfits: [] },
        state: { status: 'idle', error: '', notice: '', loadingWiki: false, wikiDocs: [{ id: 'place', title: '예시 장소' }] },
        persist: vi.fn().mockResolvedValue(undefined), saveStyle: vi.fn().mockResolvedValue('saved-copy'), loadWiki: vi.fn(),
        removeStyle: vi.fn().mockResolvedValue(true), moveStyle: vi.fn().mockResolvedValue(true),
    })
})
afterEach(() => { component?.$destroy(); component = undefined; document.body.replaceChildren() })

describe('BardPainter tools', () => {
    test('dismisses generation settings on an outside click and shows only the reference slot', async () => {
        await mount('settings')
        expect(document.querySelector('[data-painter-reference]')).not.toBeNull()
        expect(document.querySelector('[data-painter-gallery]')).toBeNull()
        await new Promise(resolve => setTimeout(resolve, 20))
        const overlay = document.querySelector('[data-dialog-overlay]')!
        expect(overlay).not.toBeNull()
        overlay.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', clientX: 10, clientY: 10 }))
        overlay.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
        overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
        await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    })
    test('keeps settings unmounted until a toolbar window opens', async () => {
        await mount(null)
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        component!.$set({ mode: 'settings' })
        await tick()
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
        expect(document.querySelector('[aria-label="이전 메시지 수"]')).not.toBeNull()
        expect(document.querySelector('[data-painter-presets]')).toBeNull()
    })
    test('edits a separate style copy and saves only on an explicit action', async () => {
        await mount('style')
        expect(document.body.textContent).toContain('기본 프리셋에는 화풍 태그가 없습니다')
        await change('화풍 작가 태그', 'example artist style')
        await change('화풍 프리셋 이름', '예시 화풍')
        expect(session.style.artist).toBe('')
        expect(session.saveStyle).not.toHaveBeenCalled()
        button('새 이름으로 저장').click()
        await tick()
        expect(session.saveStyle).toHaveBeenCalledWith(expect.objectContaining({ id: 'default', name: '예시 화풍', artist: 'example artist style' }), true)
        expect(onClose).not.toHaveBeenCalled()
    })
    test('opens the searchable character library immediately without a second disclosure step', async () => {
        await mount('characters')
        const library = document.querySelector('[data-painter-presets]')
        expect(library?.tagName).toBe('SECTION')
        expect(document.querySelector('[data-painter-person="example"]')).not.toBeNull()
        expect(document.querySelector('[aria-label="인물과 의상 검색"]')).not.toBeNull()
    })
    test('persists reference settings and resolution without making an AI request', async () => {
        await mount('settings')
        await change('이전 메시지 수', '3')
        await change('이미지 크기', '1216x832')
        await change('이미지 시드', '0')
        const wiki = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item => item.parentElement?.textContent?.includes('예시 장소'))!
        wiki.click()
        await tick()
        expect(session.data.settings.context.before).toBe(3)
        expect(session.data.settings.context.wikiIds).toEqual(['place'])
        expect(session.data.settings).toMatchObject({ width: 1216, height: 832, seed: 0 })
        await change('이미지 시드', '')
        expect(session.data.settings.seed).toBeNull()
        expect(session.persist).toHaveBeenCalled()
    })
    test('locks changes during generation but still permits closing the window', async () => {
        await mount('settings', true)
        expect(document.querySelector<HTMLInputElement>('[aria-label="이전 메시지 수"]')?.closest('fieldset')?.disabled).toBe(true)
        button('닫기').click()
        expect(onClose).toHaveBeenCalledOnce()
    })
    test('separates overwriting and copying an existing style without saving on blur', async () => {
        const custom = { ...session.style, id: 'custom', name: '저녁 화풍' }
        session.styles.push(custom); session.style = custom; session.data.settings.styleId = custom.id
        await mount('style')
        await change('화풍 프리셋 이름', '다른 화풍')
        expect(session.saveStyle).not.toHaveBeenCalled()
        button('덮어쓰기').click(); await tick()
        expect(session.saveStyle).toHaveBeenCalledWith(expect.objectContaining({ id: 'custom', name: '다른 화풍' }), false)
    })
    test('confirms discarding edits before closing and retains failed saves', async () => {
        await mount('style')
        await change('화풍 프리셋 이름', '새 화풍')
        session.saveStyle.mockResolvedValue(undefined); session.state.error = '저장 실패'
        button('새 이름으로 저장').click(); await tick()
        expect(document.querySelector<HTMLInputElement>('[aria-label="화풍 프리셋 이름"]')?.value).toBe('새 화풍')
        button('닫기').click(); await tick()
        expect(onClose).not.toHaveBeenCalled()
        button('변경 버리고 닫기').click(); await tick()
        expect(onClose).toHaveBeenCalledOnce()
    })
    test('guards navigation and deletes only after confirming the selected style', async () => {
        const custom = { ...session.style, id: 'custom', name: '저녁 화풍' }
        session.styles.push(custom); session.style = custom; session.data.settings.styleId = custom.id
        await mount('style')
        await change('화풍 작가 태그', 'edited rendering')
        document.querySelector<HTMLButtonElement>('[data-painter-style="default"]')!.click(); await tick()
        expect(session.persist).not.toHaveBeenCalled()
        button('계속 편집').click(); await tick()
        document.querySelector<HTMLButtonElement>('[aria-label="화풍 삭제"]')!.click(); await tick()
        expect(session.removeStyle).not.toHaveBeenCalled()
        button('삭제 확인').click(); await tick()
        expect(session.removeStyle).toHaveBeenCalledWith('custom')
    })
    test('exposes persisted resize controls and reorders the selected custom preset', async () => {
        const a = { ...session.style, id: 'a', name: '화풍 A' }, b = { ...session.style, id: 'b', name: '화풍 B' }
        session.styles.push(a, b); session.style = b; session.data.settings.styleId = b.id
        await mount('style')
        expect(document.querySelector('[data-manager-window-resize="se"]')).not.toBeNull()
        document.querySelector<HTMLButtonElement>('[aria-label="화풍 위로 이동"]')!.click(); await tick()
        expect(session.moveStyle).toHaveBeenCalledWith('b', -1)
    })
    test('reveals a copied style beyond the first page after clearing a search', async () => {
        session.styles.push(...Array.from({ length: 20 }, (_, n) => ({ ...session.style, id: `style-${n}`, name: `화풍 ${n}` })))
        session.saveStyle.mockImplementation(async (style: any) => {
            const saved = { ...style, id: 'copied' }; session.styles.push(saved); session.style = saved
            return saved.id
        })
        await mount('style')
        await change('화풍 검색', '기본')
        await change('화풍 프리셋 이름', '새로 저장한 화풍')
        button('새 이름으로 저장').click()
        for (let i = 0; i < 5; i++) await tick()
        expect(document.querySelector('[data-painter-style="copied"]')?.getAttribute('aria-pressed')).toBe('true')
    })
    test('guards Escape dismissal and leaves the edited style intact', async () => {
        await mount('style')
        await change('화풍 프리셋 이름', '편집 중인 이름')
        document.querySelector('[aria-label="화풍 프리셋 이름"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await tick()
        expect(onClose).not.toHaveBeenCalled()
        expect(button('변경 버리고 닫기')).toBeDefined()
        button('계속 편집').click(); await tick()
        expect(document.querySelector<HTMLInputElement>('[aria-label="화풍 프리셋 이름"]')?.value).toBe('편집 중인 이름')
    })
})
