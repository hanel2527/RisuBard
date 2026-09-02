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
        expect(Number(secondSurface.style.zIndex)).toBeLessThan(600)
        stop()
    })

    test('keeps base, alert and top tiers ordered while reopening within a tier', async () => {
        const stop = observeModalLayers(document.body)
        const appendDialog = (tier: 'base' | 'alert' | 'top') => {
            const overlay = document.body.appendChild(document.createElement('div'))
            overlay.className = 'risu-modal-overlay'
            overlay.dataset.risuModalTier = tier
            const surface = document.body.appendChild(document.createElement('section'))
            surface.className = 'risu-modal-surface'
            surface.dataset.risuModalTier = tier
            return { overlay, surface }
        }

        const base = appendDialog('base')
        const alert = appendDialog('alert')
        const top = appendDialog('top')
        await vi.waitFor(() => expect(top.surface.style.zIndex).not.toBe(''))

        base.surface.dataset.state = 'open'
        await vi.waitFor(() => expect(Number(base.surface.style.zIndex)).toBeGreaterThan(Number(base.overlay.style.zIndex)))

        expect(Number(base.surface.style.zIndex)).toBeLessThan(Number(alert.overlay.style.zIndex))
        expect(Number(alert.surface.style.zIndex)).toBeLessThan(Number(top.overlay.style.zIndex))
        expect(Number(top.surface.style.zIndex)).toBeLessThan(800)
        stop()
    })

    test('places managed floating content above its current modal without escaping the tier', async () => {
        const stop = observeModalLayers(document.body)
        const overlay = document.body.appendChild(document.createElement('div'))
        overlay.className = 'risu-modal-overlay'
        overlay.dataset.risuModalTier = 'alert'
        const surface = document.body.appendChild(document.createElement('section'))
        surface.className = 'risu-modal-surface'
        surface.dataset.risuModalTier = 'alert'
        await vi.waitFor(() => expect(surface.style.zIndex).not.toBe(''))

        const floating = document.body.appendChild(document.createElement('div'))
        floating.dataset.risuFloatingLayer = ''
        await vi.waitFor(() => expect(floating.style.zIndex).not.toBe(''))

        expect(Number(floating.style.zIndex)).toBeGreaterThan(Number(surface.style.zIndex))
        expect(Number(floating.style.zIndex)).toBeLessThan(600)
        stop()
    })

    test('keeps a local floating surface below a modal opened afterward', async () => {
        const stop = observeModalLayers(document.body)
        const dock = document.body.appendChild(document.createElement('aside'))
        dock.style.zIndex = '51'
        const floating = dock.appendChild(document.createElement('div'))
        floating.dataset.risuFloatingLayer = ''
        await vi.waitFor(() => expect(floating.style.zIndex).not.toBe(''))

        const overlay = document.body.appendChild(document.createElement('div'))
        overlay.className = 'risu-modal-overlay'
        const surface = document.body.appendChild(document.createElement('section'))
        surface.className = 'risu-modal-surface'
        await vi.waitFor(() => expect(surface.style.zIndex).not.toBe(''))

        expect(Number(floating.style.zIndex)).toBeLessThan(Number(overlay.style.zIndex))
        stop()
    })

    test('uses the ARIA trigger as the owner of portalled floating content', async () => {
        const stop = observeModalLayers(document.body)
        const base = document.body.appendChild(document.createElement('section'))
        base.dataset.risuModalTier = 'base'
        const trigger = base.appendChild(document.createElement('button'))
        trigger.setAttribute('aria-controls', 'portalled-menu')
        const alert = document.body.appendChild(document.createElement('section'))
        alert.dataset.risuModalTier = 'alert'
        await vi.waitFor(() => expect(alert.style.zIndex).not.toBe(''))

        const floating = document.body.appendChild(document.createElement('div'))
        floating.id = 'portalled-menu'
        floating.dataset.risuFloatingLayer = ''
        await vi.waitFor(() => expect(floating.style.zIndex).not.toBe(''))

        expect(Number(floating.style.zIndex)).toBe(Number(base.style.zIndex) + 1)
        expect(Number(floating.style.zIndex)).toBeLessThan(Number(alert.style.zIndex))
        stop()
    })

    test('never lets a crowded alert stack cross into the notification tier', async () => {
        const stop = observeModalLayers(document.body)
        const surfaces: HTMLElement[] = []
        for (let index = 0; index < 40; index += 1) {
            const surface = document.body.appendChild(document.createElement('section'))
            surface.dataset.risuModalTier = 'alert'
            surfaces.push(surface)
        }
        await vi.waitFor(() => expect(surfaces.at(-1)?.style.zIndex).not.toBe(''))

        expect(Math.max(...surfaces.map((surface) => Number(surface.style.zIndex)))).toBeLessThan(600)
        stop()
    })

    test('does not let a hidden retained modal own new floating content', async () => {
        const stop = observeModalLayers(document.body)
        const visible = document.body.appendChild(document.createElement('section'))
        visible.dataset.risuModalTier = 'alert'
        const hidden = document.body.appendChild(document.createElement('section'))
        hidden.dataset.risuModalTier = 'alert'
        await vi.waitFor(() => expect(hidden.style.zIndex).not.toBe(''))

        hidden.style.display = 'none'
        const floating = document.body.appendChild(document.createElement('div'))
        floating.dataset.risuFloatingLayer = ''
        await vi.waitFor(() => expect(floating.style.zIndex).not.toBe(''))

        expect(Number(floating.style.zIndex)).toBe(Number(visible.style.zIndex) + 1)
        stop()
    })

    test('brings a retained modal to front when it is reopened', async () => {
        const stop = observeModalLayers(document.body)
        const first = document.body.appendChild(document.createElement('section'))
        first.className = 'risu-modal-surface'
        const second = document.body.appendChild(document.createElement('section'))
        second.className = 'risu-modal-surface'
        await vi.waitFor(() => expect(second.style.zIndex).not.toBe(''))
        first.dataset.state = 'open'
        await vi.waitFor(() => expect(Number(first.style.zIndex)).toBeGreaterThan(Number(second.style.zIndex)))
        expect(Number(first.style.zIndex)).toBeLessThan(600)
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
        overlay.dataset.state = 'open'
        await vi.waitFor(() => expect(Number(surface.style.zIndex)).toBeGreaterThan(Number(overlay.style.zIndex)))
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
