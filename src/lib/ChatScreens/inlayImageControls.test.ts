import { describe, expect, test, vi } from 'vitest'
import { inlayImageControls, removeInlayOccurrence } from './inlayImageControls'

describe('removing an image from a message', () => {
    test('removes only the selected occurrence across legacy and current inlay syntax', () => {
        const data = 'Before {{inlay::shared}} middle {{inlayed::shared}} after {{inlayeddata::shared}} {{inlay::other}}'
        expect(removeInlayOccurrence(data, 'shared', 1)).toBe('Before {{inlay::shared}} middle  after {{inlayeddata::shared}} {{inlay::other}}')
    })

    test('preserves text when the selected occurrence or asset is no longer present', () => {
        const data = 'Text {{inlay::shared}}'
        expect(removeInlayOccurrence(data, 'missing', 0)).toBe(data)
        expect(removeInlayOccurrence(data, 'shared', 1)).toBe(data)
        expect(removeInlayOccurrence(data, 'shared', -1)).toBe(data)
    })

    test('compares IDs literally without interpreting regex characters', () => {
        expect(removeInlayOccurrence('{{inlay::a.b}} {{inlay::axb}}', 'a.b', 0)).toBe(' {{inlay::axb}}')
    })
})

test('attaches controls to asynchronously loaded images and removes controls when editing is disabled', async () => {
    const root = document.createElement('div')
    const remove = vi.fn()
    const controls = inlayImageControls(root, remove)
    root.innerHTML = '<img data-inlay-image-id="late" data-inlay-occurrence="0" src="/late.png">'
    await new Promise(resolve => setTimeout(resolve, 0))
    const image = root.querySelector('img')
    root.querySelector('button')!.click()
    expect(remove).toHaveBeenCalledWith('late', 0)
    controls.update(undefined)
    expect(root.querySelector('button')).toBeNull()
    expect(root.firstChild).toBe(image)
    controls.destroy()
})
