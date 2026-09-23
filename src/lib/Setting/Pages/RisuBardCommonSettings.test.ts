import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import RisuBardCommonSettings from './RisuBardCommonSettings.svelte'
import { risuBardCommonSettingsItems } from 'src/ts/setting/risuBardCommonSettingsData'

vi.mock('../SettingRenderer.svelte', async () => ({ default: (await import('./CommonSettingsRenderer.fixture.svelte')).default }))
vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: {} } }))
let component: ReturnType<typeof mount>
afterEach(async () => {
    if (component) await unmount(component)
    document.body.replaceChildren()
    vi.restoreAllMocks()
})

describe('common settings jump navigation', () => {
    it('keeps every section and draft input mounted while jumping and transfers focus', async () => {
        component = mount(RisuBardCommonSettings, { target: document.body })
        await tick()
        const headers = risuBardCommonSettingsItems.filter((item) => item.type === 'header')
        const sections = [...document.querySelectorAll<HTMLElement>('[data-common-section]')]
        expect(sections.map((section) => section.dataset.commonSection)).toEqual(headers.map((item) => item.id))
        expect(document.querySelector('[role="tablist"]')).toBeNull()
        expect(document.querySelectorAll('[data-test-renderer][data-compact="true"]')).toHaveLength(headers.length)
        const input = document.querySelector<HTMLInputElement>('input')!
        input.value = 'unfinished draft'
        const lastSection = sections.at(-1)!
        const scroll = vi.spyOn(lastSection, 'scrollIntoView').mockImplementation(() => {})
        const buttons = [...document.querySelectorAll<HTMLButtonElement>('nav button')]
        buttons.at(-1)!.click()
        await tick()
        expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' })
        expect(document.activeElement).toBe(lastSection)
        expect(document.querySelector('input')).toBe(input)
        expect(input.value).toBe('unfinished draft')
        expect(document.querySelectorAll('[data-common-section]')).toHaveLength(headers.length)
    })

    it('jumps directly to embedding without hiding the analysis section', async () => {
        component = mount(RisuBardCommonSettings, { target: document.body })
        await tick()
        const target = document.querySelector<HTMLElement>('[data-setting-id="risubard.embedding"]')!
        const scroll = vi.spyOn(target, 'scrollIntoView').mockImplementation(() => {})
        const button = [...document.querySelectorAll<HTMLButtonElement>('nav button')].find((button) => button.textContent === '의미 검색 임베딩')!
        button.click()
        await tick()
        expect(document.activeElement).toBe(target)
        expect(scroll).toHaveBeenCalledOnce()
        expect(target.closest('[data-common-section]')).not.toBeNull()
    })
})
