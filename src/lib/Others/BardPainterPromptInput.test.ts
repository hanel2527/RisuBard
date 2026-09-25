import { afterEach, describe, expect, test, vi } from 'vitest'
import { tick } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import BardPainterPromptInput from './BardPainterPromptInput.svelte'

let component: ReturnType<typeof createClassComponent> | undefined
async function mount(props: Record<string, unknown> = {}) {
    component = createClassComponent({ component: BardPainterPromptInput, target: document.body,
        props: { 'aria-label': 'Prompt', ...props } })
    await tick()
    return document.querySelector('textarea')!
}
afterEach(() => { component?.$destroy(); component = undefined; document.body.replaceChildren() })

describe('weighted prompt input', () => {
    test('keeps the native text intact and renders safe, accessible background marks', async () => {
        const value = 'plain, 1.5::red hair::, 0.5::<img src=x onerror=alert(1)>::\n'
        const input = await mount({ value, rows: 4 })
        expect(input.value).toBe(value)
        expect(input.getAttribute('rows')).toBe('4')
        expect(document.querySelector('img')).toBeNull()
        const mirror = document.querySelector('[data-prompt-mirror]')!
        expect(mirror.getAttribute('aria-hidden')).toBe('true')
        expect([...mirror.querySelectorAll('[data-weight]')].map(part => part.textContent).join('')).toBe(value)
        expect(mirror.querySelector('[data-tone="strong"]')?.textContent).toContain('red hair')
        expect(mirror.querySelector('[data-tone="weak"]')?.textContent).toContain('<img')
    })
    test('updates marks during native input without moving selection or replacing the textarea', async () => {
        const oninput = vi.fn()
        const input = await mount({ value: '', oninput })
        input.value = '-1::rain::'
        input.setSelectionRange(4, 6)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(oninput).toHaveBeenCalledOnce()
        expect(document.querySelector('textarea')).toBe(input)
        expect(input.selectionStart).toBe(4)
        expect(input.selectionEnd).toBe(6)
        expect(document.querySelector('[data-tone="weak"]')?.textContent).toContain('rain')
    })
    test('reflects external edits, forwards native props, and follows scrolling', async () => {
        const input = await mount({ value: 'old', disabled: true, placeholder: 'write here' })
        expect(input.disabled).toBe(true)
        expect(input.placeholder).toBe('write here')
        component!.$set({ value: '2::new::', disabled: false })
        await tick()
        expect(input.disabled).toBe(false)
        expect(input.value).toBe('2::new::')
        expect(document.querySelector('[data-tone="strong"]')?.textContent).toContain('new')
        input.scrollTop = 42
        input.scrollLeft = 10
        input.dispatchEvent(new Event('scroll'))
        await tick()
        expect(document.querySelector<HTMLElement>('[data-prompt-content]')!.style.transform).toBe('translate(-10px, -42px)')
    })
})
