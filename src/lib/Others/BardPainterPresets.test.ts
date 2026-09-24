import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { tick } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import { createPainterChatData } from 'src/ts/bardPainter/types'
import { painterTestState } from './BardPainterTestState.svelte'
import BardPainterPresets from './BardPainterPresets.svelte'

let component: ReturnType<typeof createClassComponent> | undefined
let session: any
const dirtyChange = vi.fn()
function mount(disabled = false) {
    component = createClassComponent({ component: BardPainterPresets, target: document.body, props: { session, disabled, expanded: true, onDirtyChange: dirtyChange } })
}
function button(label: string) {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
    expect(found, `button: ${label}`).toBeDefined()
    return found!
}
async function click(label: string) { button(label).click(); await tick(); await tick() }
async function change(label: string, value: string) {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`)!
    expect(input, label).not.toBeNull()
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
}
beforeEach(() => {
    dirtyChange.mockReset()
    session = painterTestState({
        data: { ...createPainterChatData(), outfits: [
            { id: 'local-a', subjectId: 'person-a', name: '연습복', clothing: 'gray shirt', state: '' },
            { id: 'local-b', subjectId: 'person-b', name: '작업복', clothing: 'blue overalls', state: '' },
        ] },
        bot: { identities: [
            { id: 'person-a', name: '예시 인물 A', aliases: ['별칭 A'], appearance: 'short brown hair' },
            { id: 'person-b', name: '예시 인물 B', aliases: [], appearance: 'long black hair' },
        ], outfits: [{ id: 'shared-a', subjectId: 'person-a', name: '예복', clothing: 'formal jacket', state: 'clean' }] },
        state: { error: '' },
        saveIdentity: vi.fn(async (identity: any, asNew: boolean) => {
            const saved = { ...identity, id: asNew || !identity.id ? 'new-person' : identity.id }
            const index = session.bot.identities.findIndex((item: any) => item.id === saved.id)
            if (index < 0) session.bot.identities.push(saved); else session.bot.identities[index] = saved
            return saved.id
        }),
        saveOutfitPreset: vi.fn(async (outfit: any, shared: boolean, asNew: boolean) => {
            const saved = { ...outfit, id: asNew || !outfit.id ? 'new-outfit' : outfit.id }
            const owner = shared ? session.bot : session.data
            const index = owner.outfits.findIndex((item: any) => item.id === saved.id)
            if (index < 0) owner.outfits.push(saved); else owner.outfits[index] = saved
            return saved.id
        }),
        removeIdentity: vi.fn().mockResolvedValue(true), removeOutfit: vi.fn().mockResolvedValue(true),
        moveIdentity: vi.fn().mockResolvedValue(true), moveOutfit: vi.fn().mockResolvedValue(true),
    })
})
afterEach(() => { component?.$destroy(); component = undefined; document.body.replaceChildren() })

describe('BardPainter character and outfit manager', () => {
    test('opens a single editor without auto-saving field changes', async () => {
        mount(); await tick()
        expect(document.querySelector('[data-painter-presets]')?.tagName).toBe('SECTION')
        expect(document.querySelector('[data-painter-presets] > .presets-heading')).toBeNull()
        expect(document.querySelectorAll('[data-preset-editor]')).toHaveLength(1)
        await change('인물 이름', '수정한 인물')
        await change('인물 별칭', '하나, 둘, 하나')
        await change('기본 외형', 'green eyes')
        expect(session.bot.identities[0].name).toBe('예시 인물 A')
        expect(session.saveIdentity).not.toHaveBeenCalled()
        expect(dirtyChange).toHaveBeenLastCalledWith(true)
        await click('덮어쓰기')
        expect(session.saveIdentity).toHaveBeenCalledWith({ id: 'person-a', name: '수정한 인물', aliases: ['하나', '둘'], appearance: 'green eyes' }, false)
        expect(dirtyChange).toHaveBeenLastCalledWith(false)
    })
    test('copies an identity with a new name without copying its outfits', async () => {
        mount(); await tick()
        expect(button('새 이름으로 저장').disabled).toBe(true)
        await change('인물 이름', '다른 인물')
        await click('새 이름으로 저장')
        expect(session.saveIdentity).toHaveBeenCalledWith(expect.objectContaining({ name: '다른 인물' }), true)
        expect(session.bot.identities[0].name).toBe('예시 인물 A')
        expect(session.data.outfits[0].subjectId).toBe('person-a')
        expect(document.body.textContent).toContain('의상은 원래 인물에 남습니다')
    })
    test('creates a person and an outfit directly without a generated prompt', async () => {
        mount(); await tick()
        await click('새 인물')
        expect(button('저장').disabled).toBe(true)
        await change('인물 이름', '새 인물 예시')
        await change('기본 외형', 'silver hair')
        await click('저장')
        expect(session.saveIdentity).toHaveBeenCalledWith(expect.objectContaining({ name: '새 인물 예시' }), true)
        await click('새 의상')
        await change('의상 이름', '새 망토')
        await change('의상 프롬프트', 'silver cloak')
        await change('새 의상 저장 범위', 'shared')
        await click('저장')
        expect(session.saveOutfitPreset).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 'new-person', name: '새 망토', clothing: 'silver cloak' }), true, true)
        expect(session.data.draft).toBeUndefined()
    })
    test('requires discard confirmation before another selection or new entry', async () => {
        mount(); await tick()
        await change('기본 외형', 'unsaved appearance')
        await click('예시 인물 B 외형 편집')
        expect(document.querySelector<HTMLTextAreaElement>('[aria-label="기본 외형"]')?.value).toBe('unsaved appearance')
        await click('계속 편집')
        await click('새 인물')
        await click('변경 버리고 계속')
        expect(document.querySelector<HTMLInputElement>('[aria-label="인물 이름"]')?.value).toBe('')
        expect(session.bot.identities[0].appearance).toBe('short brown hair')
    })
    test('overwrites the original scope and copies to a selected scope', async () => {
        mount(); await tick()
        await click('연습복 의상 편집')
        await change('의상 프롬프트', 'navy coat')
        await change('복사할 저장 범위', 'shared')
        await click('덮어쓰기')
        expect(session.saveOutfitPreset).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'local-a', clothing: 'navy coat' }), false, false)
        await change('복사할 저장 범위', 'shared')
        await click('새 이름으로 저장')
        expect(session.saveOutfitPreset).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'local-a' }), true, true)
    })
    test('preserves a failed save draft and reports the failure', async () => {
        session.saveIdentity.mockImplementation(async () => { session.state.error = '저장 장치 오류'; return undefined })
        mount(); await tick()
        await change('기본 외형', 'unsaved appearance')
        await click('덮어쓰기')
        expect(document.querySelector<HTMLTextAreaElement>('[aria-label="기본 외형"]')?.value).toBe('unsaved appearance')
        expect(document.querySelector('[role="status"]')?.textContent).toContain('저장 장치 오류')
        expect(dirtyChange).toHaveBeenLastCalledWith(true)
    })
    test('confirms scoped deletions and explains character cascade', async () => {
        mount(); await tick()
        await click('삭제')
        expect(session.removeIdentity).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('모든 챗에 저장한 이 인물의 의상')
        await click('삭제 취소')
        await click('예복 의상 편집')
        await click('삭제')
        expect(document.body.textContent).toContain('「예복」(봇 공용)')
        await click('삭제 확인')
        expect(session.removeOutfit).toHaveBeenCalledWith('shared-a', true)
    })
    test('reorders only within the correct owner and scope with boundary controls', async () => {
        session.data.outfits.push({ id: 'local-a-2', subjectId: 'person-a', name: '등산복', clothing: 'hiking jacket', state: '' })
        mount(); await tick()
        expect(button('예시 인물 A 위로').disabled).toBe(true)
        expect(button('예시 인물 B 아래로').disabled).toBe(true)
        await click('예시 인물 B 위로')
        expect(session.moveIdentity).toHaveBeenCalledWith('person-b', -1)
        expect(button('연습복 위로').disabled).toBe(true)
        await click('연습복 아래로')
        expect(session.moveOutfit).toHaveBeenCalledWith('local-a', false, 1)
        expect(button('예복 아래로').disabled).toBe(true)
    })
    test('searches across the full library and keeps nested ownership and scopes', async () => {
        session.bot.identities = Array.from({ length: 100 }, (_, i) => ({ id: `person-${i}`, name: `인물 ${i}`, aliases: [], appearance: '' }))
        session.bot.outfits = []
        session.data.outfits = [{ id: 'last-outfit', subjectId: 'person-99', name: '달빛 망토', clothing: 'silver cloak', state: '' }]
        mount(); await tick()
        expect(document.querySelectorAll('[data-painter-person]')).toHaveLength(12)
        await change('인물과 의상 검색', '달빛')
        expect(document.querySelectorAll('[data-painter-person]')).toHaveLength(1)
        expect(document.querySelector('[data-painter-person="person-99"]')?.textContent).toContain('달빛 망토')
        await change('의상 저장 범위', 'shared')
        expect(document.body.textContent).toContain('검색 결과가 없습니다')
        await click('검색과 필터 초기화')
        expect(document.querySelectorAll('[data-painter-person]')).toHaveLength(12)
    })
    test('bounds a large outfit list and preserves stored order', async () => {
        session.bot.outfits = []
        session.data.outfits = Array.from({ length: 14 }, (_, i) => ({ id: `o-${i}`, subjectId: 'person-a', name: `의상 ${14 - i}`, clothing: 'sample', state: '' }))
        mount(); await tick()
        expect(document.querySelectorAll('[data-painter-outfit]')).toHaveLength(8)
        expect(document.querySelector('[data-painter-outfit]')?.getAttribute('data-painter-outfit')).toBe('o-0')
        await click('의상 더 보기 (6개)')
        expect(document.querySelectorAll('[data-painter-outfit]')).toHaveLength(14)
    })
    test('retains orphan ownership and can register that owner without moving outfits', async () => {
        session.data.outfits.push({ id: 'orphan', subjectId: 'unknown-owner', name: '별도 의상', clothing: 'green coat', state: '' })
        mount(); await tick()
        await click('이름 미등록 (unknown-) 외형 편집')
        await change('인물 이름', '복원한 인물')
        await click('저장')
        expect(session.saveIdentity).toHaveBeenCalledWith(expect.objectContaining({ id: 'unknown-owner' }), false)
        expect(session.data.outfits[2].subjectId).toBe('unknown-owner')
    })
    test('disables changes while busy and ignores old operation completion after session changes', async () => {
        let finish!: (id: string) => void
        session.saveIdentity.mockImplementation(() => new Promise<string>(resolve => finish = resolve))
        mount(); await tick()
        await change('기본 외형', 'pending appearance')
        await click('덮어쓰기')
        expect(button('새 인물').disabled).toBe(true)
        const next = painterTestState({ ...session, bot: { identities: [], outfits: [] }, data: createPainterChatData(), state: { error: '' } })
        component!.$set({ session: next }); await tick()
        expect(button('새 인물').disabled).toBe(false)
        finish('person-a'); await tick(); await tick()
        expect(document.querySelector('[role="status"]')?.textContent).not.toContain('저장했습니다')
    })
    test('keeps a newly saved person and outfit visible beyond the initial list limit', async () => {
        session.bot.identities = Array.from({ length: 20 }, (_, i) => ({ id: `person-${i}`, name: `인물 ${i}`, aliases: [], appearance: '' }))
        session.bot.outfits = []; session.data.outfits = []
        mount(); await tick()
        await click('새 인물')
        await change('인물 이름', '목록 끝 인물')
        await click('저장')
        expect(document.querySelector('[data-painter-person="new-person"]')).not.toBeNull()
        session.data.outfits = Array.from({ length: 9 }, (_, i) => ({ id: `outfit-${i}`, subjectId: 'new-person', name: `의상 ${i}`, clothing: 'example', state: '' }))
        await tick()
        await click('새 의상')
        await change('의상 이름', '목록 끝 의상')
        await change('의상 프롬프트', 'blue jacket')
        await click('저장')
        expect(document.querySelector('[data-painter-outfit="new-outfit"]')).not.toBeNull()
    })
    test('retains an outfit draft if deletion fails', async () => {
        session.removeOutfit.mockImplementation(async () => { session.state.error = '삭제 저장 실패'; return false })
        mount(); await tick()
        await click('연습복 의상 편집')
        await change('의상 프롬프트', 'draft clothing')
        await click('삭제'); await click('삭제 확인')
        expect(document.querySelector<HTMLTextAreaElement>('[aria-label="의상 프롬프트"]')?.value).toBe('draft clothing')
        expect(document.querySelector('[role="status"]')?.textContent).toContain('삭제 저장 실패')
        expect(dirtyChange).toHaveBeenLastCalledWith(true)
    })
    test('keeps every mutation disabled while a generation operation is active', async () => {
        mount(true); await tick()
        expect(button('새 인물').disabled).toBe(true)
        expect(button('새 의상').disabled).toBe(true)
        expect(button('삭제').disabled).toBe(true)
        expect(button('예시 인물 A 아래로').disabled).toBe(true)
        expect(document.querySelector<HTMLFieldSetElement>('[data-preset-editor]')?.disabled).toBe(true)
        button('덮어쓰기').click()
        expect(session.saveIdentity).not.toHaveBeenCalled()
    })
})
