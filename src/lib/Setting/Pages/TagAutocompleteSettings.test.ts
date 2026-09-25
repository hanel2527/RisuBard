import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import TagAutocompleteSettings from './TagAutocompleteSettings.svelte'
import type { TagAutocompleteSettings as Settings } from 'src/ts/tagAutocomplete/settings'

const { db } = vi.hoisted(() => ({ db: { tagAutocomplete: undefined as Settings | undefined, hotkeys: [] } }))
vi.mock('src/ts/stores.svelte', async () => {
    const { SvelteMap } = await import('svelte/reactivity')
    const values = new SvelteMap<string, Settings | undefined>()
    Object.defineProperty(db, 'tagAutocomplete', {
        get: () => values.get('settings'), set: value => values.set('settings', value),
    })
    return { DBState: { db } }
})

describe('tag autocomplete settings controls', () => {
    let component: ReturnType<typeof mount>
    let target: HTMLDivElement
    beforeEach(async () => {
        db.tagAutocomplete = undefined
        target = document.createElement('div')
        document.body.append(target)
        component = mount(TagAutocompleteSettings, { target })
        await tick()
    })
    afterEach(async () => { await unmount(component); target.remove() })

    it('persists minimum length and restores it on reopening settings', async () => {
        const input = target.querySelector<HTMLInputElement>('input[type=number]')!
        expect(input.value).toBe('1')
        input.value = '5'
        input.dispatchEvent(new Event('change', { bubbles: true }))
        expect(db.tagAutocomplete?.minLength).toBe(5)
        await unmount(component)
        db.tagAutocomplete = JSON.parse(JSON.stringify(db.tagAutocomplete))
        component = mount(TagAutocompleteSettings, { target })
        await tick()
        expect(target.querySelector<HTMLInputElement>('input[type=number]')?.value).toBe('5')
    })

    it('persists the enable toggle and replacement mode', () => {
        const enabled = target.querySelector<HTMLInputElement>('input[type=checkbox]')!
        enabled.checked = false
        enabled.dispatchEvent(new Event('change', { bubbles: true }))
        const scope = target.querySelector<HTMLSelectElement>('select')!
        scope.value = 'whole'
        scope.dispatchEvent(new Event('change', { bubbles: true }))
        expect(db.tagAutocomplete).toMatchObject({ enabled: false, scope: 'whole' })
    })

    it('captures an exact custom shortcut without propagating and restores defaults', async () => {
        const input = target.querySelector<HTMLInputElement>('[aria-label="후보 확정 1 키"]')!
        const event = new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })
        const parent = vi.fn()
        target.addEventListener('keydown', parent)
        input.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(true)
        expect(parent).not.toHaveBeenCalled()
        expect(db.tagAutocomplete?.hotkeys.accept[0]).toMatchObject({ key: 'j', ctrl: true, alt: true, shift: false, meta: false })
        await tick()
        expect(input.value).toBe('Ctrl+Alt+j')
        const reset = Array.from(target.querySelectorAll('button')).find(button => button.textContent?.includes('기본값 복원'))!
        reset.click()
        await tick()
        expect(db.tagAutocomplete?.hotkeys.accept.map(binding => binding.key)).toEqual(['Enter', 'Tab'])
        expect(input.value).toBe('Enter')
    })

    it('updates visible controls and duplicate warnings immediately', async () => {
        const input = target.querySelector<HTMLInputElement>('[aria-label="후보 확정 1 키"]')!
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await tick()
        expect(target.querySelector('[aria-live="polite"]')?.textContent).toContain('중복')
        db.tagAutocomplete = { ...db.tagAutocomplete!, minLength: 7 }
        await tick()
        expect(target.querySelector<HTMLInputElement>('input[type=number]')?.value).toBe('7')
    })
})
