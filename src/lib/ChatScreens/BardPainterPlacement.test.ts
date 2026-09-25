import { afterEach, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { painterInsertionRequest } from 'src/ts/bardPainter/selectionState'
vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: { characters: [{ chaId: 'bot', name: 'Bot', chats: [{ id: 'chat', message: [{ chatId: 'm', data: 'First.\n\nLast.' }] }] }] } } }))
vi.mock('src/ts/personaScopes', () => ({ resolvePersonaById: () => null }))
import BardPainterPlacement from './BardPainterPlacement.svelte'
let component: ReturnType<typeof mount> | undefined
afterEach(async () => { if (component) await unmount(component); component = undefined; painterInsertionRequest.set(null); document.body.replaceChildren() })
async function setup() {
    const root = document.createElement('div')
    root.dataset.painterMessage = '0'; root.innerHTML = '<p>First.</p><p>Last.</p>'
    document.body.append(root)
    root.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100)
    root.querySelectorAll('p').forEach((p, i) => { p.getBoundingClientRect = () => new DOMRect(0, i * 60, 300, 30) })
    const insert = vi.fn(async () => true)
    painterInsertionRequest.set({ characterId: 'bot', chatId: 'chat', resultId: 'image', insert })
    component = mount(BardPainterPlacement, { target: document.body, props: { characterId: 'bot', chatId: 'chat' } })
    await tick(); await tick()
    return { root, insert }
}
test.each(['Escape', 'contextmenu'])('cancels placement with %s without inserting', async (action) => {
    const { root, insert } = await setup()
    const event = action === 'Escape' ? new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) : new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true })
    root.dispatchEvent(event); await tick()
    expect(get(painterInsertionRequest)).toBeNull()
    expect(event.defaultPrevented).toBe(true)
    expect(insert).not.toHaveBeenCalled()
    expect(document.body.classList.contains('painter-placing')).toBe(false)
})
test('left click places the image at the selected paragraph boundary', async () => {
    const { root, insert } = await setup()
    root.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 45, bubbles: true }))
    root.dispatchEvent(new MouseEvent('click', { button: 0, detail: 1, clientX: 20, clientY: 45, bubbles: true }))
    await tick(); await tick()
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ characterId: 'bot', chatId: 'chat', messageId: 'm', start: 8, end: 8 }))
    expect(get(painterInsertionRequest)).toBeNull()
})
test.each(['scroll', 'load', 'resize'])('keeps the chosen insertion line aligned after %s', async eventType => {
    const { root, insert } = await setup()
    root.dispatchEvent(new PointerEvent('pointermove', { clientY: 45, bubbles: true }))
    await tick()
    expect(document.querySelector<HTMLElement>('.placement-marker')?.style.top).toBe('45px')
    root.querySelectorAll('p').forEach((p, i) => { p.getBoundingClientRect = () => new DOMRect(0, 120 + i * 60, 300, 30) })
    ;(eventType === 'resize' ? window : root).dispatchEvent(new Event(eventType))
    await tick()
    expect(document.querySelector<HTMLElement>('.placement-marker')?.style.top).toBe('165px')
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await tick(); await tick()
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ start: 8, end: 8 }))
})
test('does not move an unmapped boundary to the start after displayed paragraphs change', async () => {
    const { root, insert } = await setup()
    root.dispatchEvent(new PointerEvent('pointermove', { clientY: 45, bubbles: true }))
    await tick()
    root.innerHTML = '<p>First. Last.</p>'
    root.querySelector('p')!.getBoundingClientRect = () => new DOMRect(0, 0, 300, 30)
    root.dispatchEvent(new Event('load'))
    await tick()
    expect(document.querySelector('.placement-marker')).toBeNull()
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await tick(); await tick()
    expect(insert).not.toHaveBeenCalled()
})
