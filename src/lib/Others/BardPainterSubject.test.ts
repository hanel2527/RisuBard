import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { tick } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import BardPainterSubject from './BardPainterSubject.svelte'
import { painterTestState } from './BardPainterTestState.svelte'

let component: ReturnType<typeof createClassComponent> | undefined
let session: any
let subject: any
async function mount(disabled = false) {
    component = createClassComponent({ component: BardPainterSubject, target: document.body,
        props: { subject, session, disabled, index: 0, total: 2, onMove: vi.fn(), onRemove: vi.fn() } })
    await tick()
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
        applyOutfit: vi.fn(),
    })
    subject = session.data.draft.subjects[0]
})
afterEach(() => { component?.$destroy(); component = undefined; document.body.replaceChildren() })

describe('compact subject prompt editor', () => {
    test('starts with one prompt field and keeps advanced controls behind more', async () => {
        await mount()
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
        await mount()
        await change('대상 1 프롬프트', ' long hair \n\n red coat \n\n facing front ')
        expect(subject).toMatchObject({ prompt: ' long hair \n\n red coat \n\n facing front ', appearance: 'long hair', clothing: 'red coat', state: '', pose: 'facing front' })
    })
    test('selecting presets does not change prompt text or the linked character', async () => {
        await mount()
        await change('대상 1 캐릭터 불러오기', 'saved-person')
        await change('대상 1 의상 불러오기', 'cape')
        expect(subject).toMatchObject({ id: 'draft-person', name: 'Current', aliases: [], appearance: 'short hair', clothing: 'old jacket', pose: 'looking left' })
        expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('short hair\n\nold jacket\n\nlooking left')
        expect(session.persist).not.toHaveBeenCalled()
        expect(session.applyOutfit).not.toHaveBeenCalled()
    })
    test('pastes character text at the remembered caret without reassigning identity', async () => {
        session.data.draft.subjects.push({ ...subject, id: 'saved-person' })
        await mount()
        const editor = document.querySelector<HTMLTextAreaElement>('textarea')!
        const before = editor.value
        editor.focus(); editor.setSelectionRange(5, 5)
        editor.dispatchEvent(new Event('select')); editor.blur()
        await change('대상 1 캐릭터 불러오기', 'saved-person')
        expect(document.querySelector<HTMLButtonElement>('[aria-label="대상 1 캐릭터 붙여넣기"]')!.disabled).toBe(false)
        document.querySelector<HTMLButtonElement>('[aria-label="대상 1 캐릭터 붙여넣기"]')!.click()
        await tick()
        expect(editor.value).toBe(before.slice(0, 5) + 'long hair' + before.slice(5))
        expect(subject.prompt).toBe(editor.value)
        expect(subject.id).toBe('draft-person')
        expect(subject.name).toBe('Current')
        expect(editor.selectionStart).toBe(14)
        expect(document.activeElement).toBe(editor)
    })
    test('pastes outfit text over only the selected range and continues at the new caret', async () => {
        await mount()
        await change('대상 1 프롬프트', 'AI detail / replace here / pose, smile')
        const editor = document.querySelector<HTMLTextAreaElement>('textarea')!
        editor.focus(); editor.setSelectionRange(12, 24)
        editor.dispatchEvent(new Event('select')); editor.blur()
        await change('대상 1 의상 불러오기', 'cape')
        const paste = document.querySelector<HTMLButtonElement>('[aria-label="대상 1 의상 붙여넣기"]')!
        paste.click(); await tick()
        expect(editor.value).toBe('AI detail / green cape, dusty / pose, smile')
        expect(subject.prompt).toBe(editor.value)
        paste.click(); await tick()
        expect(editor.value).toBe('AI detail / green cape, dustygreen cape, dusty / pose, smile')
        expect(subject.id).toBe('draft-person')
    })
    test('appends raw text when no cursor has been placed and disables empty or deleted presets', async () => {
        await mount()
        const editor = document.querySelector<HTMLTextAreaElement>('textarea')!
        const before = editor.value
        const paste = document.querySelector<HTMLButtonElement>('[aria-label="대상 1 캐릭터 붙여넣기"]')!
        expect(paste.disabled).toBe(true)
        await change('대상 1 캐릭터 불러오기', 'saved-person')
        paste.click(); await tick()
        expect(editor.value).toBe(before + 'long hair')
        session.bot.identities = []; await tick()
        expect(paste.disabled).toBe(true)
    })
    test('keeps all editing controls disabled during generation', async () => {
        await mount(true)
        expect(document.querySelector('fieldset')?.disabled).toBe(true)
        expect(document.querySelectorAll('textarea')).toHaveLength(1)
    })
})
