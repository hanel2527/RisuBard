import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { tick } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import { createPainterChatData, type PainterDraft, type PainterResult } from 'src/ts/bardPainter/types'
import BardPainter from './BardPainter.svelte'
import { painterTestState } from './BardPainterTestState.svelte'
import { painterSelection, painterInsertionRequest } from 'src/ts/bardPainter/selectionState'
import { get } from 'svelte/store'

vi.mock('src/ts/stores.svelte', () => ({ botMakerMode: { set: vi.fn() }, CharConfigSubMenu: { set: vi.fn() }, risuBardGalleryOpen: { set: vi.fn() }, MobileSideBar: { set: vi.fn() } }))
vi.mock('src/ts/bardPainter/gallery', async () => { const { writable } = await import('svelte/store'); return { painterGalleryRequested: writable(null) } })

const runtime = vi.hoisted(() => ({ current: null as any }))
vi.mock('src/ts/bardPainter/runtime.svelte', () => ({ getPainterSession: () => runtime.current }))

let component: ReturnType<typeof createClassComponent> | undefined
const anchor = { characterId: 'bot', chatId: 'chat', messageId: 'message', start: 4, end: 11, text: '붉은 보석함' }
const draft = (): PainterDraft => ({ rendering: 'watercolor', scene: 'night, indoors', negative: '', subjects: [
    { id: 'aria', name: '아리아', aliases: ['아리'], kind: 'character', appearance: 'black hair', clothing: 'white shirt', state: 'wet clothes', pose: 'standing', negative: '' },
] })
const result = (id = 'result'): PainterResult => ({
    id, assetId: id, createdAt: 1, anchor: { ...anchor }, draft: draft(),
    style: { id: 'ink', name: '잉크', artist: 'artist style', rendering: 'ink', negative: '', steps: 28, scale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral' },
    settings: createPainterChatData().settings, seed: 42,
})
function mount(visible = true) {
    component = createClassComponent({ component: BardPainter, target: document.body, props: { characterId: 'bot', chatId: 'chat', visible } })
}
function button(label: string) {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent?.trim() === label)
    expect(found, `button: ${label}`).toBeDefined()
    return found!
}
beforeEach(() => {
    painterSelection.set(null)
    painterInsertionRequest.set(null)
    const data = createPainterChatData()
    const style = result().style
    runtime.current = painterTestState({
        data, bot: { identities: [], outfits: [] }, style, styles: [style],
        state: { status: 'idle', error: '', notice: '', wikiDocs: [], loadingWiki: false, pendingImage: false },
        ...Object.fromEntries(['prepare', 'generate', 'retrySave', 'cancel', 'insert', 'loadWiki', 'persist', 'saveOutfit', 'promoteOutfit', 'applyOutfit', 'removeOutfit', 'rememberIdentity', 'saveStyle', 'removeResult', 'downloadOriginal', 'restoreDraft'].map(name => [name, vi.fn()])),
    })
    data.settings.styleId = style.id
})
afterEach(() => { component?.$destroy(); component = undefined; document.body.replaceChildren() })

describe('BardPainter workspace', () => {
    test('offers specified placement with the same accent as before and after', async () => {
        runtime.current.data.anchor = { ...anchor }
        runtime.current.data.draft = draft()
        runtime.current.data.results = [result()]
        mount(); await tick()
        for (const label of ['위에 삽입', '아래에 삽입', '지정 삽입']) expect(button(label).classList.contains('primary')).toBe(true)
        button('지정 삽입').click(); await tick()
        expect(get(painterInsertionRequest)).toMatchObject({ characterId: 'bot', chatId: 'chat', resultId: 'result', messageId: 'message' })
        expect(runtime.current.insert).not.toHaveBeenCalled()
        const position = { ...anchor, start: 7, end: 7 }
        await get(painterInsertionRequest)!.insert(position)
        expect(runtime.current.insert).toHaveBeenCalledWith('result', 'after', position)
    })
    test('places generation settings beside the compact image generation action', async () => {
        mount(); await tick()
        const row = button('이미지 생성').parentElement!
        expect([...row.querySelectorAll('button')].some(button => button.textContent === '생성 설정')).toBe(true)
        expect(button('이미지 생성').classList.contains('generate')).toBe(false)
    })
    test('shows toolbar actions and enables explicit preparation on the first highlight', async () => {
        mount()
        expect(button('화풍')).toBeDefined()
        expect(button('캐릭터')).toBeDefined()
        expect(button('생성 설정')).toBeDefined()
        expect(document.querySelector('[aria-label="이전 메시지 수"]')).toBeNull()
        expect(button('프롬프트 작성').disabled).toBe(true)
        painterSelection.set({ characterId: 'bot', chatId: 'chat', anchor: { ...anchor } })
        await tick()
        expect(button('프롬프트 작성').disabled).toBe(false)
        expect(runtime.current.prepare).not.toHaveBeenCalled()
        button('프롬프트 작성').click()
        expect(runtime.current.prepare).toHaveBeenCalledWith(anchor, expect.objectContaining({ fresh: false }))
    })
    test('keeps the draft scene pinned while a new selection becomes the insertion destination', async () => {
        runtime.current.data.anchor = { ...anchor }
        runtime.current.data.draft = draft()
        runtime.current.data.results = [result()]
        mount()
        const destination = { ...anchor, messageId: 'elsewhere', start: 0, end: 20, text: '다른 삽입 위치', insertionUnavailable: true }
        painterSelection.set({ characterId: 'bot', chatId: 'chat', anchor: destination })
        await tick()
        expect(button('이미지 생성').disabled).toBe(false)
        expect(document.querySelector('[aria-label="그릴 장면"]')?.textContent).toContain(anchor.text)
        expect(runtime.current.data.anchor).toEqual(anchor)
        button('아래에 삽입').click()
        expect(runtime.current.insert).toHaveBeenCalledWith('result', 'after', destination)
    })
    test('requires an explicit scene change before replacing the pinned draft', async () => {
        runtime.current.data.anchor = { ...anchor }; runtime.current.data.draft = draft()
        mount()
        const next = { ...anchor, start: 20, end: 28, text: '새 장면' }
        painterSelection.set({ characterId: 'bot', chatId: 'chat', anchor: next })
        await tick()
        button('이 선택으로 장면 바꾸기').click()
        await tick()
        expect(runtime.current.data.draft).toBeDefined()
        button('장면 변경 확인').click()
        await tick()
        expect(runtime.current.data.anchor).toEqual(next)
        expect(runtime.current.data.draft).toBeUndefined()
    })
    test('sends refinement instructions with the pinned scene without generating an image', async () => {
        runtime.current.data.anchor = { ...anchor }; runtime.current.data.draft = draft()
        mount()
        const composer = document.querySelector<HTMLTextAreaElement>('[aria-label="프롬프트 대화 입력"]')!
        composer.value = '구도를 가깝게'
        composer.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        button('초안 개선').click()
        expect(runtime.current.prepare).toHaveBeenCalledWith(anchor, { instruction: '구도를 가깝게', fresh: false })
        expect(runtime.current.generate).not.toHaveBeenCalled()
    })
    test('keeps the latest result only even when the chat has hundreds of illustrations', () => {
        runtime.current.data.results = Array.from({ length: 300 }, (_, i) => ({ ...result(`result-${i}`), createdAt: i }))
        mount()
        expect(document.querySelectorAll('img')).toHaveLength(1)
        expect(document.querySelector('[data-painter-result]')?.getAttribute('data-painter-result')).toBe('result-299')
        expect(document.querySelector('[aria-label="삽화 보관함"]')).toBeNull()
        expect(button('갤러리 열기')).toBeDefined()
    })
    test('does not insert incomplete compressed images and keeps recovery actions', () => {
        runtime.current.state.pendingImage = true
        runtime.current.data.results = [{ ...result(), compressionPending: true }]
        mount()
        expect(button('아래에 삽입').disabled).toBe(true)
        button('저장 다시 시도').click(); button('원본 다운로드').click()
        expect(runtime.current.retrySave).toHaveBeenCalledOnce()
        expect(runtime.current.downloadOriginal).toHaveBeenCalledOnce()
    })
    test('unmounts preview images when the painter view is hidden', async () => {
        runtime.current.data.results = [result()]
        mount()
        expect(document.querySelectorAll('img')).toHaveLength(1)
        component!.$set({ visible: false }); await tick()
        expect(document.querySelectorAll('img')).toHaveLength(0)
    })
})
