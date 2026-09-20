// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import RisuBardWikiExportDialog from './RisuBardWikiExportDialog.svelte'
import type { NarrativeMemoryWikiMarkdown } from 'src/ts/risubard/memoryWiki'

let component: ReturnType<typeof mount> | undefined
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.innerHTML = ''; vi.restoreAllMocks() })
function doc(id: string, type: 'character' | 'event' | 'other', relativePath: string) {
    return { id, type, relativePath, title: id, status: 'active', content: '# ' + id, sourceMessageIds: [], updated: '', links: [], contextMode: 'auto', contentHash: '' } as NarrativeMemoryWikiMarkdown['documents'][number]
}
test('selects and deselects multiple rows with a drag and excludes events and arc plot', async () => {
    const onExport = vi.fn(async () => {})
    component = mount(RisuBardWikiExportDialog, { target: document.body, props: { open: true, documents: [
        doc('alice', 'character', 'characters/alice.md'), doc('bob', 'character', 'characters/bob.md'),
        doc('carol', 'character', 'characters/carol.md'),
        doc('event', 'event', 'events/event.md'), { ...doc('arc', 'other', 'notes/arc-plot.md'), title: '스토리 아크 플롯' },
    ], onExport } })
    await tick()
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[data-export-document]')]
    expect(rows).toHaveLength(5)
    expect(rows[3].disabled).toBe(true)
    expect(rows[4].disabled).toBe(true)
    rows[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }))
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(rows[2])
    rows[2].dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup'))
    await tick()
    expect(rows[0].getAttribute('aria-pressed')).toBe('true')
    expect(rows[1].getAttribute('aria-pressed')).toBe('true')
    expect(rows[2].getAttribute('aria-pressed')).toBe('true')
    rows[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 2 }))
    rows[2].dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 2 }))
    window.dispatchEvent(new PointerEvent('pointerup'))
    await tick()
    expect(rows[0].getAttribute('aria-pressed')).toBe('false')
    expect(rows[1].getAttribute('aria-pressed')).toBe('false')
    expect(rows[2].getAttribute('aria-pressed')).toBe('false')
    rows[0].click()
    await tick()
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '내보내기')!
    save.click()
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledWith(['alice']))
})
