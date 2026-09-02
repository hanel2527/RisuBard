// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { MenuDef } from '../../ts/stores.svelte'
import PluginFloatingActionButtons from './PluginFloatingActionButtons.svelte'

let mounted: ReturnType<typeof mount> | undefined

function menu(callback = vi.fn()): MenuDef {
    return {
        id: 'main',
        pluginName: 'sample-plugin',
        layoutKey: '["sample-plugin","id","main"]',
        name: 'Sample action',
        icon: 'S',
        iconType: 'html',
        callback,
    }
}

beforeEach(() => {
    Object.defineProperties(window, {
        innerWidth: { configurable: true, value: 400 },
        innerHeight: { configurable: true, value: 300 },
    })
})

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('PluginFloatingActionButtons', () => {
    test('keeps a normal click connected to the plugin callback', () => {
        const callback = vi.fn()
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(PluginFloatingActionButtons, {
            target,
            props: { buttons: [menu(callback)] },
        })

        const button = target.querySelector<HTMLButtonElement>(
            '[data-plugin-fab="sample-plugin:main"]'
        )
        expect(button?.getAttribute('aria-label')).toBe('Sample action')
        button?.click()
        expect(callback).toHaveBeenCalledOnce()
    })

    test('persists a drag without invoking the plugin callback', async () => {
        const callback = vi.fn()
        const onPlacementChange = vi.fn()
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(PluginFloatingActionButtons, {
            target,
            props: {
                buttons: [menu(callback)],
                onPlacementChange,
            },
        })
        const button = target.querySelector<HTMLButtonElement>(
            '[data-plugin-fab="sample-plugin:main"]'
        )!
        button.setPointerCapture = vi.fn()
        button.getBoundingClientRect = () => ({
            x: 332,
            y: 16,
            left: 332,
            top: 16,
            right: 384,
            bottom: 52,
            width: 52,
            height: 36,
            toJSON: () => ({}),
        })

        button.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            pointerId: 7,
            clientX: 358,
            clientY: 34,
        }))
        button.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            pointerId: 7,
            clientX: 200,
            clientY: 150,
        }))
        button.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            pointerId: 7,
            clientX: 200,
            clientY: 150,
        }))
        button.click()
        await tick()

        expect(button.setPointerCapture).toHaveBeenCalledWith(7)
        expect(onPlacementChange).toHaveBeenCalledWith(
            '["sample-plugin","id","main"]',
            { xRatio: 0.5, yRatio: 0.5 }
        )
        expect(callback).not.toHaveBeenCalled()

        button.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'Home',
        }))
        await tick()
        expect(button.style.left).toBe('358px')
        expect(button.style.top).toBe('34px')
    })

    test('restores a saved position and supports keyboard reset', () => {
        const onPlacementChange = vi.fn()
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(PluginFloatingActionButtons, {
            target,
            props: {
                buttons: [menu()],
                placements: {
                    '["sample-plugin","id","main"]': {
                        xRatio: 0.25,
                        yRatio: 0.5,
                    },
                },
                onPlacementChange,
            },
        })
        const button = target.querySelector<HTMLButtonElement>(
            '[data-plugin-fab="sample-plugin:main"]'
        )!

        expect(button.style.left).toBe('100px')
        expect(button.style.top).toBe('150px')
        button.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'Home',
        }))
        expect(onPlacementChange).toHaveBeenCalledWith(
            '["sample-plugin","id","main"]',
            null
        )
    })

    test('falls back safely when persisted placement storage is corrupt', () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(PluginFloatingActionButtons, {
            target,
            props: {
                buttons: [menu()],
                placements: null as never,
            },
        })

        const button = target.querySelector<HTMLButtonElement>(
            '[data-plugin-fab="sample-plugin:main"]'
        )!
        expect(button.style.left).toBe('358px')
        expect(button.style.top).toBe('34px')
    })
})
