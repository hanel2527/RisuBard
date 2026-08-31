import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import ShAlertDialog from './ShAlertDialog.svelte'
import { observeModalLayers } from './modalLayerStack'

afterEach(() => {
    document.body.innerHTML = ''
})

describe('modal layer stack', () => {
    test('raises each newly opened canonical modal above the previous surface and BardWiki', async () => {
        const stop = observeModalLayers(document.body)
        const wiki = document.body.appendChild(document.createElement('aside'))
        wiki.style.zIndex = '51'

        const firstOverlay = document.body.appendChild(document.createElement('div'))
        firstOverlay.className = 'risu-modal-overlay'
        const firstSurface = document.body.appendChild(document.createElement('section'))
        firstSurface.className = 'risu-modal-surface'
        await vi.waitFor(() => expect(firstSurface.style.zIndex).not.toBe(''))

        const secondOverlay = document.body.appendChild(document.createElement('div'))
        secondOverlay.className = 'risu-modal-overlay'
        const secondSurface = document.body.appendChild(document.createElement('section'))
        secondSurface.className = 'risu-modal-surface'
        await vi.waitFor(() => expect(secondSurface.style.zIndex).not.toBe(''))

        expect(Number(firstOverlay.style.zIndex)).toBeGreaterThan(Number(wiki.style.zIndex))
        expect(Number(firstSurface.style.zIndex)).toBeGreaterThan(Number(firstOverlay.style.zIndex))
        expect(Number(secondOverlay.style.zIndex)).toBeGreaterThan(Number(firstSurface.style.zIndex))
        expect(Number(secondSurface.style.zIndex)).toBeGreaterThan(Number(secondOverlay.style.zIndex))
        stop()
    })

    test('brings a retained modal to front when it is reopened', async () => {
        const stop = observeModalLayers(document.body)
        const first = document.body.appendChild(document.createElement('section'))
        first.className = 'risu-modal-surface'
        const second = document.body.appendChild(document.createElement('section'))
        second.className = 'risu-modal-surface'
        await vi.waitFor(() => expect(second.style.zIndex).not.toBe(''))
        const previousTop = Number(second.style.zIndex)

        first.dataset.state = 'open'
        await vi.waitFor(() => expect(Number(first.style.zIndex)).toBeGreaterThan(previousTop))
        stop()
    })

    test('keeps a reopened portal surface above its overlay even when mutations arrive in reverse order', async () => {
        const stop = observeModalLayers(document.body)
        const overlay = document.body.appendChild(document.createElement('div'))
        overlay.className = 'risu-modal-overlay'
        const surface = document.body.appendChild(document.createElement('section'))
        surface.className = 'risu-modal-surface'
        await vi.waitFor(() => expect(surface.style.zIndex).not.toBe(''))

        surface.dataset.state = 'open'
        overlay.dataset.state = 'open'
        await vi.waitFor(() => {
            expect(Number(surface.style.zIndex)).toBeGreaterThan(Number(overlay.style.zIndex))
        })
        stop()
    })

    test('keeps a portal surface clickable when its overlay reopens in a later mutation batch', async () => {
        const stop = observeModalLayers(document.body)
        const overlay = document.body.appendChild(document.createElement('div'))
        overlay.className = 'risu-modal-overlay'
        const surface = document.body.appendChild(document.createElement('section'))
        surface.className = 'risu-modal-surface'
        await vi.waitFor(() => expect(surface.style.zIndex).not.toBe(''))

        surface.dataset.state = 'open'
        await vi.waitFor(() => {
            expect(Number(surface.style.zIndex)).toBeGreaterThan(Number(overlay.style.zIndex))
        })
        const surfaceLayer = Number(surface.style.zIndex)

        overlay.dataset.state = 'open'
        await vi.waitFor(() => {
            expect(Number(overlay.style.zIndex)).toBeGreaterThan(surfaceLayer)
        })

        expect(Number(surface.style.zIndex)).toBeGreaterThan(Number(overlay.style.zIndex))
        stop()
    })

    test('keeps the real alert dialog surface above its blurred overlay', async () => {
        const stop = observeModalLayers(document.body)
        const mounted = mount(ShAlertDialog, {
            target: document.body,
            props: { open: true },
        })
        const overlay = await vi.waitFor(() => {
            const element = document.querySelector<HTMLElement>('.risu-modal-overlay')
            expect(element).not.toBeNull()
            return element!
        })
        const surface = document.querySelector<HTMLElement>('.risu-modal-surface')!

        overlay.dataset.state = 'closed'
        await vi.waitFor(() => expect(overlay.dataset.state).toBe('closed'))
        overlay.dataset.state = 'open'
        await vi.waitFor(() => {
            expect(Number(surface.style.zIndex)).toBeGreaterThan(Number(overlay.style.zIndex))
        })

        await unmount(mounted)
        stop()
    })
})
