import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { tick } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import BardPainterSubject from './BardPainterSubject.svelte'
import { painterTestState } from './BardPainterTestState.svelte'
import { replaceSubjectOutfit } from 'src/ts/bardPainter/subjectPrompt'

let component: ReturnType<typeof createClassComponent> | undefined
let session: any
let subject: any
function mount(disabled = false) {
    component = createClassComponent({ component: BardPainterSubject, target: document.body,
        props: { subject, session, disabled, index: 0, total: 2, onMove: vi.fn(), onRemove: vi.fn() } })
}
async function change(label: string, value: string) {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`)!
    expect(input, label).not.toBeNull()
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
}
beforeEach(() => {
    session = painterTestState({
        data: { draft: { subjects: [{ id: 'draft-person', name: 'Current', aliases: [], kind: 'character', appearance: 'short hair', clothing: 'old jacket', state: '', pose: 'looking left', negative: '' }] }, outfits: [] },
        bot: { identities: [{ id: 'saved-person', name: 'Saved', aliases: ['Alias'], appearance: 'long hair' }],
            outfits: [{ id: 'cape', subjectId: 'saved-person', name: 'Travel cape', clothing: 'green cape', state: 'dusty' }] },
        state: { notice: '', error: '' },
        persist: vi.fn().mockResolvedValue(undefined), rememberIdentity: vi.fn(), saveOutfit: vi.fn(),
        applyOutfit: async (subjectId: string, outfitId: string) => {
            const target = session.data.draft.subjects.find((item: any) => item.id === subjectId)
            const outfit = session.bot.outfits.find((item: any) => item.id === outfitId && item.subjectId === subjectId)
            if (target && outfit) replaceSubjectOutfit(target, outfit.clothing, outfit.state)
        },
    })
    subject = session.data.draft.subjects[0]
})
afterEach(() => { component?.$destroy(); component = undefined; document.body.replaceChildren() })

describe('compact subject prompt editor', () => {
    test('starts with one prompt field and keeps advanced controls behind more', async () => {
        mount()
        expect(document.querySelectorAll('textarea')).toHaveLength(1)
        expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('short hair\n\nold jacket\n\nlooking left')
        expect(document.querySelector('[aria-label="대상 1 종류"]')).toBeNull()
        const details = document.querySelector<HTMLDetailsElement>('[data-subject-more]')!
        details.open = true
        details.dispatchEvent(new Event('toggle'))
        await tick()
        expect(document.querySelector('[aria-label="대상 1 종류"]')).not.toBeNull()
        expect(document.querySelectorAll('textarea')).toHaveLength(2)
    })
    test('preserves direct edits and exposes sections for preset saves', async () => {
        mount()
        await change('대상 1 프롬프트', ' long hair \n\n red coat \n\n facing front ')
        expect(subject).toMatchObject({ prompt: ' long hair \n\n red coat \n\n facing front ', appearance: 'long hair', clothing: 'red coat', state: '', pose: 'facing front' })
    })
    test('loads character identity and its clothes while retaining the rest of the prompt', async () => {
        mount()
        await change('대상 1 캐릭터 불러오기', 'saved-person')
        expect(subject).toMatchObject({ id: 'saved-person', name: 'Saved', aliases: ['Alias'], appearance: 'long hair', clothing: 'old jacket', pose: 'looking left' })
        expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('long hair\n\nold jacket\n\nlooking left')
        await change('대상 1 의상 불러오기', 'cape')
        expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('long hair\n\ngreen cape, dusty\n\nlooking left')
        expect(subject).toMatchObject({ clothing: 'green cape', state: 'dusty', pose: 'looking left' })
    })
    test('does not reuse an identity already owned by another draft block', async () => {
        session.data.draft.subjects.push({ ...subject, id: 'saved-person' })
        mount()
        await change('대상 1 캐릭터 불러오기', 'saved-person')
        expect(subject.id).toBe('draft-person')
        expect(subject.appearance).toBe('short hair')
        expect(document.querySelector('[role="status"]')?.textContent).toContain('다른 블록')
    })
    test('keeps all editing controls disabled during generation', () => {
        mount(true)
        expect(document.querySelector('fieldset')?.disabled).toBe(true)
        expect(document.querySelectorAll('textarea')).toHaveLength(1)
    })
})
