import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import SettingRowLayout from './SettingRowLayout.svelte'
import { language } from 'src/lang'
import { alertMd } from 'src/ts/alert'

vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: {} } }))
vi.mock('src/ts/alert', () => ({ alertMd: vi.fn() }))
let component: ReturnType<typeof mount>
afterEach(async () => {
    if (component) await unmount(component)
    document.body.replaceChildren()
    vi.clearAllMocks()
})
describe('optional compact settings rows', () => {
    const item = { id: 'test', type: 'number' as const, fallbackLabel: 'Recent turns', helpKey: 'risuBardResponseRecentMessages' }
    it('keeps help inline by default for other pages', async () => {
        component = mount(SettingRowLayout, { target: document.body, props: { item } })
        await tick()
        expect(document.querySelector('p')?.textContent).toBe(language.help.risuBardResponseRecentMessages)
    })
    it('makes the full help available on demand in compact mode', async () => {
        component = mount(SettingRowLayout, {
            target: document.body, props: { item },
            context: new Map([['settings-compact-rows', () => true]]),
        })
        await tick()
        expect(document.querySelector('p')).toBeNull()
        const help = document.querySelector('button')!
        help.click()
        expect(alertMd).toHaveBeenCalledWith(language.help.risuBardResponseRecentMessages)
    })
})
