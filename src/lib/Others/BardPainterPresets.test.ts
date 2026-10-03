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
        get botCatalog() { const refs = this.bot.globalOutfits ?? []; return { identities: this.bot.identities, outfits: [...this.bot.outfits, ...(this.globalLibrary?.outfits ?? []).filter((item: any) => !item.subjectId && refs.some((ref: any) => ref.id === item.id))] } },
        data: { ...createPainterChatData(), outfits: [
            { id: 'local-a', subjectId: 'person-a', name: '연습복', clothing: 'gray shirt', state: '' },
            { id: 'local-b', subjectId: 'person-b', name: '작업복', clothing: 'blue overalls', state: '' },
        ] },
        bot: { identities: [
            { id: 'person-a', name: '예시 인물 A', aliases: ['별칭 A'], appearance: 'short brown hair' },
            { id: 'person-b', name: '예시 인물 B', aliases: [], appearance: 'long black hair' },
        ], outfits: [{ id: 'shared-a', subjectId: 'person-a', name: '예복', clothing: 'formal jacket', state: 'clean' }] },
        state: { error: '' },
        setAllCardAttachments: vi.fn(async (attached: boolean) => {
            session.bot.identities = session.bot.identities.map((item: any) => ({ ...item, attachToCard: attached }))
            session.bot.outfits = session.bot.outfits.map((item: any) => ({ ...item, attachToCard: attached }))
            return true
        }),
        saveIdentity: vi.fn(async (identity: any, asNew: boolean, global = false) => {
            const saved = { ...identity, id: asNew || !identity.id ? 'new-person' : identity.id }
            const owner = global ? session.globalLibrary : session.bot
            const index = owner.identities.findIndex((item: any) => item.id === saved.id)
            if (index < 0) owner.identities.push(saved); else owner.identities[index] = saved
            return saved.id
        }),
        saveOutfitPreset: vi.fn(async (outfit: any, shared: boolean, asNew: boolean, global = false) => {
            const saved = { ...outfit, id: asNew || !outfit.id ? 'new-outfit' : outfit.id }
            const owner = global ? session.globalLibrary : shared ? session.bot : session.data
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
    test('copies characters to global and protects unsaved edits when switching libraries', async () => {
        session.globalLibrary = { identities: [{ id: 'global-person', name: '글로벌 인물', aliases: [], appearance: 'blue eyes' }], outfits: [] }
        session.copyIdentityToGlobal = vi.fn().mockResolvedValue('copy')
        session.importGlobalIdentity = vi.fn().mockResolvedValue('import')
        mount(); await tick()
        await click('글로벌에 복사')
        expect(session.copyIdentityToGlobal).toHaveBeenCalledWith('person-a')
        await change('기본 외형', 'unsaved')
        await change('프리셋 보관함', 'global')
        expect(document.body.textContent).toContain('저장하지 않은 변경 내용')
        await click('변경 버리고 계속')
        expect(document.querySelector<HTMLInputElement>('[aria-label="인물 이름"]')?.value).toBe('글로벌 인물')
        expect(document.querySelector('[aria-label="봇에 첨부"]')).toBeNull()
        expect([...document.querySelectorAll('button')].some(item => item.textContent === '로어 연결')).toBe(false)
        await click('현재 봇으로 가져오기')
        expect(session.importGlobalIdentity).toHaveBeenCalledWith('global-person')
    })
    test('creates independent outfits and assigns the same outfit with a default to a character', async () => {
        session.setIdentityOutfits = vi.fn(async (id: string, ids: string[], defaultId?: string) => {
            const identity = session.bot.identities.find((item: any) => item.id === id)
            identity.outfitIds = ids; identity.defaultOutfitId = defaultId; return true
        })
        session.globalLibrary = { identities: [], outfits: [{ id: 'global-dress', subjectId: '', name: '드레스', clothing: 'white dress', state: '' }] }
        session.setBotGlobalOutfits = vi.fn(async (ids: string[]) => { session.bot.globalOutfits = ids.map(id => ({ id })); return true })
        mount(); await tick()
        // A new shared outfit is saved to the global library and selected for this bot.
        await click('새 공용 의상')
        await change('의상 이름', '학교 교복'); await change('의상 프롬프트', 'school uniform')
        await click('저장')
        expect(session.saveOutfitPreset).toHaveBeenCalledWith(expect.objectContaining({ subjectId: '', clothing: 'school uniform' }), true, true, true)
        expect(session.setBotGlobalOutfits).toHaveBeenLastCalledWith(['new-outfit'])
        // Unselected global outfits stay out of each character's outfit list until picked.
        await click('예시 인물 B 외형 편집')
        expect(document.querySelector('[aria-label="드레스 사용"]')).toBeNull()
        await click('글로벌에서 선택')
        const pick = document.querySelector<HTMLInputElement>('[aria-label="드레스 이 봇에서 사용"]')!
        pick.click(); await tick(); await tick()
        expect(session.setBotGlobalOutfits).toHaveBeenLastCalledWith(['new-outfit', 'global-dress'])
        await click('예시 인물 B 외형 편집')
        const checkbox = document.querySelector<HTMLInputElement>('[aria-label="학교 교복 사용"]')!
        checkbox.click(); await tick(); await tick()
        expect(session.setIdentityOutfits).toHaveBeenLastCalledWith('person-b', ['new-outfit'], undefined)
        await change('기본 의상', 'new-outfit')
        expect(session.setIdentityOutfits).toHaveBeenLastCalledWith('person-b', ['new-outfit'], 'new-outfit')
        await change('기본 외형', 'red eyes'); await click('덮어쓰기')
        expect(session.saveIdentity).toHaveBeenLastCalledWith(expect.objectContaining({ outfitIds: ['new-outfit'], defaultOutfitId: 'new-outfit' }), false)
    })
    test('edits global characters and independent outfits without changing the bot library', async () => {
        session.globalLibrary = { identities: [{ id: 'g', name: '공통 인물', aliases: [], appearance: 'blue eyes' }], outfits: [] }
        session.copyOutfitToGlobal = vi.fn().mockResolvedValue('copy')
        session.importGlobalOutfit = vi.fn().mockResolvedValue('import')
        mount(); await tick()
        await change('프리셋 보관함', 'global')
        await change('기본 외형', 'green eyes'); await click('덮어쓰기')
        expect(session.saveIdentity).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'g', appearance: 'green eyes' }), false, true)
        expect(session.bot.identities[0].appearance).toBe('short brown hair')
        await click('새 공용 의상'); await change('의상 이름', '정장'); await change('의상 프롬프트', 'black suit'); await click('저장')
        expect(session.saveOutfitPreset).toHaveBeenLastCalledWith(expect.objectContaining({ subjectId: '', name: '정장' }), true, true, true)
        await click('현재 봇으로 가져오기')
        expect(session.importGlobalOutfit).toHaveBeenCalledWith('new-outfit')
    })
    test('does not falsely show a failed outfit association as selected', async () => {
        session.bot.outfits.push({ id: 'uniform', subjectId: '', name: '교복', clothing: 'school uniform', state: '' })
        session.setIdentityOutfits = vi.fn(async () => { session.state.error = '의상 연결 저장 실패'; return false })
        mount(); await tick()
        const checkbox = document.querySelector<HTMLInputElement>('[aria-label="교복 사용"]')!
        checkbox.click(); await tick(); await tick()
        expect(checkbox.checked).toBe(false)
        expect(document.body.textContent).toContain('의상 연결 저장 실패')
    })
    test('reports failed lore writes and allows unlinking after retry', async () => {
        session.loreEntries = [{ id: 'lore-a', title: '연결한 로어', content: 'story', identityId: 'person-a' }]
        session.setLoreIdentity = vi.fn(async () => { session.state.error = '로어 저장 실패'; return false })
        mount(); await tick(); await click('로어 연결'); await click('연결한 로어 연결 해제')
        expect(session.setLoreIdentity).toHaveBeenCalledWith('lore-a', undefined)
        expect(document.body.textContent).toContain('로어 저장 실패')
        expect(button('연결한 로어 연결 해제').getAttribute('aria-pressed')).toBe('true')
        session.setLoreIdentity.mockImplementation(async () => { session.loreEntries[0].identityId = undefined; return true })
        await click('연결한 로어 연결 해제')
        expect(button('연결한 로어 연결').getAttribute('aria-pressed')).toBe('false')
    })
    test('opens a searchable lore picker and requires an explicit replacement action', async () => {
        session.loreEntries = [{ id: 'lore-a', title: '등장인물 기록', content: 'story', identityId: 'person-b' }]
        session.setLoreIdentity = vi.fn().mockResolvedValue(true)
        mount(); await tick()
        await click('로어 연결')
        await change('로어 검색', '기록')
        await click('등장인물 기록 연결 변경')
        expect(session.setLoreIdentity).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('예시 인물 B')
        await click('이 인물로 연결 변경')
        expect(session.setLoreIdentity).toHaveBeenCalledWith('lore-a', 'person-a')
    })
    test('applies bulk attachment outside search filters while preserving unsaved editor text', async () => {
        mount(); await tick()
        await change('기본 외형', 'unsaved green eyes')
        await change('인물과 의상 검색', '예시 인물 A')
        await click('모든 항목 첨부')
        expect(session.setAllCardAttachments).toHaveBeenLastCalledWith(true)
        expect(session.bot.identities[1].attachToCard).toBe(true)
        expect(document.querySelector<HTMLInputElement>('[aria-label="봇에 첨부"]')?.checked).toBe(true)
        expect(document.querySelector<HTMLTextAreaElement>('[aria-label="기본 외형"]')?.value).toBe('unsaved green eyes')
        expect(session.saveIdentity).not.toHaveBeenCalled()
        expect(dirtyChange).toHaveBeenLastCalledWith(true)
        await click('모든 항목 미첨부')
        expect(session.setAllCardAttachments).toHaveBeenLastCalledWith(false)
        expect(document.querySelector<HTMLInputElement>('[aria-label="봇에 첨부"]')?.checked).toBe(false)
        expect(session.data.outfits.every((item: any) => item.attachToCard === undefined)).toBe(true)
    })
    test('keeps attachment off by default and only persists it when the preset is saved', async () => {
        mount(); await tick()
        const checkbox = document.querySelector<HTMLInputElement>('[aria-label="봇에 첨부"]')!
        expect(checkbox).not.toBeNull()
        expect(checkbox.checked).toBe(false)
        checkbox.click(); await tick()
        expect(session.bot.identities[0].attachToCard).toBeUndefined()
        await click('덮어쓰기')
        expect(session.bot.identities[0].attachToCard).toBe(true)
        checkbox.click(); await tick()
        await click('덮어쓰기')
        expect(session.bot.identities[0].attachToCard).not.toBe(true)
    })
    test('requires a separate attachment choice for shared outfits and never exposes it for chat outfits', async () => {
        mount(); await tick()
        await click('연습복 의상 편집')
        expect(document.querySelector('[aria-label="봇에 첨부"]')).toBeNull()
        await click('예복 의상 편집')
        const checkbox = document.querySelector<HTMLInputElement>('[aria-label="봇에 첨부"]')!
        expect(checkbox.checked).toBe(false)
        checkbox.click(); await tick(); await click('덮어쓰기')
        expect(session.bot.outfits[0].attachToCard).toBe(true)
        expect(session.bot.identities[0].attachToCard).toBeUndefined()
        await change('의상 이름', '복사한 예복'); await click('새 이름으로 저장')
        expect(session.bot.outfits.at(-1).attachToCard).not.toBe(true)
    })
    test('opens a single editor without auto-saving field changes', async () => {
        mount(); await tick()
        expect(document.querySelector('[data-painter-presets]')?.tagName).toBe('SECTION')
        expect(document.querySelector('[data-painter-presets] > .presets-heading')).toBeNull()
        expect(document.querySelectorAll('[data-preset-editor]')).toHaveLength(1)
        await change('인물 이름', '수정한 인물')
        await change('인물 별칭', '하나, 둘, 하나')
        await change('식별 메모', ' 예시 인물 B의 언니 ')
        await change('기본 외형', 'green eyes')
        expect(session.bot.identities[0].name).toBe('예시 인물 A')
        expect(session.saveIdentity).not.toHaveBeenCalled()
        expect(dirtyChange).toHaveBeenLastCalledWith(true)
        await click('덮어쓰기')
        expect(session.saveIdentity).toHaveBeenCalledWith({ id: 'person-a', name: '수정한 인물', aliases: ['하나', '둘'], note: '예시 인물 B의 언니', appearance: 'green eyes' }, false)
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
        await click('편집 범위 도움말')
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
