import { afterEach, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { DBState } from 'src/ts/stores.svelte'
import { createWikiPromptPreset } from 'src/ts/risubard/wikiPromptPreset'
import RisuBardWikiPromptSettings from './RisuBardWikiPromptSettings.svelte'

vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: {} } }))
vi.mock('src/ts/alert', () => ({ alertConfirm: vi.fn(), notifyError: vi.fn(), notifySuccess: vi.fn() }))
vi.mock('src/ts/globalApi.svelte', () => ({ downloadFile: vi.fn() }))
vi.mock('src/ts/util', () => ({ selectSingleFile: vi.fn() }))
// Keep the actual settings header and portaled dialog, isolating the unrelated editors.
vi.mock('./RisuBardWikiPromptV2Workspace.svelte', async () => ({ default: (await import('src/lib/UI/GUI/TextInput.svelte')).default }))
vi.mock('./RisuBardWikiPromptReferenceSheet.svelte', async () => ({ default: (await import('src/lib/UI/GUI/TextInput.svelte')).default }))

let mounted: ReturnType<typeof mount> | undefined
afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

test('opens all presets outside the constrained page and filters and selects a distant entry', async () => {
    const presets = Array.from({ length: 40 }, (_, index) => createWikiPromptPreset(`picker-${index}`, `Preset ${index}`))
    DBState.db = {
        risuBardWikiPromptPresets: presets,
        risuBardChatWikiPromptPresetId: presets[0].id,
    } as typeof DBState.db
    mounted = mount(RisuBardWikiPromptSettings, { target: document.body })
    await tick()
    const tabs = document.querySelectorAll<HTMLButtonElement>('[data-settings-section-tabs] button')
    tabs[1].click()
    await tick()
    const trigger = document.querySelector('[data-settings-preset-header]') as HTMLButtonElement
    expect(trigger).not.toBeNull()
    trigger.click()
    await tick()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.closest('[data-settings-page-body]')).toBeNull()
    expect(dialog.querySelectorAll('.preset-picker button')).toHaveLength(40)
    const search = dialog.querySelector('.picker-search input') as HTMLInputElement
    search.value = 'Preset 39'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    const choices = dialog.querySelectorAll<HTMLButtonElement>('.preset-picker button')
    expect(choices).toHaveLength(1)
    choices[0].click()
    await tick()
    expect(DBState.db.risuBardChatWikiPromptPresetId).toBe('picker-39')
    expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull()
})
