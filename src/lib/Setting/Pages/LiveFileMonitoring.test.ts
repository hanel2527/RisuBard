import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import LiveFileMonitoring from './LiveFileMonitoring.svelte'

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }))
vi.mock('src/ts/globalApi.svelte', () => ({ forageStorage: {
    getLiveFileMonitoring: mocks.get,
    setLiveFileMonitoring: mocks.set,
} }))
vi.mock('src/lang', () => ({ language: {
    liveFileMonitoringTitle: 'External file monitoring',
    liveFileMonitoringDesc: 'Applies to all devices. Off by default on Termux.',
    liveFileMonitoringFailed: 'Could not update setting',
    liveFileMonitoringRetry: 'Retry', loading: 'Loading',
} }))

let component: ReturnType<typeof mount> | undefined
function render() {
    component = mount(LiveFileMonitoring, { target: document.body })
    flushSync()
}
function control() { return document.querySelector<HTMLButtonElement>('[role="switch"]')! }
beforeEach(() => {
    mocks.get.mockReset().mockResolvedValue({ enabled: true, defaultEnabled: true })
    mocks.set.mockReset()
})
afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    document.body.replaceChildren()
})

describe('server-wide monitoring setting', () => {
    it('loads the server setting and restores the switch after a rejected update', async () => {
        mocks.set.mockRejectedValue(new Error('Finish external editing first'))
        render()
        await vi.waitFor(() => expect(control().disabled).toBe(false))
        expect(control().getAttribute('aria-checked')).toBe('true')
        control().click()
        await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Finish external editing first'))
        expect(control().getAttribute('aria-checked')).toBe('true')
        expect(control().disabled).toBe(false)
        expect(mocks.set).toHaveBeenCalledExactlyOnceWith(false)
    })

    it('disables the control during a save and shows the acknowledged setting', async () => {
        let resolveSet!: (status: { enabled: boolean, defaultEnabled: boolean }) => void
        mocks.set.mockImplementation(() => new Promise(resolve => { resolveSet = resolve }))
        render()
        await vi.waitFor(() => expect(control().disabled).toBe(false))
        control().click()
        await vi.waitFor(() => expect(control().disabled).toBe(true))
        resolveSet({ enabled: false, defaultEnabled: true })
        await vi.waitFor(() => expect(control().disabled).toBe(false))
        expect(control().getAttribute('aria-checked')).toBe('false')
        expect(mocks.set).toHaveBeenCalledExactlyOnceWith(false)
    })

    it('allows a failed initial status request to be retried', async () => {
        mocks.get.mockRejectedValueOnce(new Error('Offline'))
        render()
        await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Offline'))
        expect(control().disabled).toBe(true)
        ;[...document.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click()
        await vi.waitFor(() => expect(control().disabled).toBe(false))
        expect(control().getAttribute('aria-checked')).toBe('true')
        expect(mocks.get).toHaveBeenNthCalledWith(2, true)
    })
})
