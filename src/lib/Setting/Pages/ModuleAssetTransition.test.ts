import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import ModuleAssetTransition from './ModuleAssetTransition.svelte'

const mocks = vi.hoisted(() => ({
    db: { modules: [] as { id: string; name: string; assets?: unknown[] }[] },
    transition: vi.fn(),
    overview: vi.fn(),
}))
vi.mock('src/ts/stores.svelte', () => ({ DBState: { get db() { return mocks.db } } }))
vi.mock('src/ts/platform', () => ({ isNodeServer: true }))
vi.mock('src/ts/globalApi.svelte', () => ({ forageStorage: {
    Init: vi.fn(async () => undefined),
    realStorage: { moduleAssetTransition: mocks.transition, storagePackageOverview: mocks.overview },
} }))

let component: ReturnType<typeof mount> | undefined
beforeEach(() => {
    mocks.db.modules = [{ id: 'mod', name: 'Fate', assets: [1, 2, 3] }, { id: 'twin', name: 'Fate', assets: [] }]
    mocks.transition.mockReset()
    mocks.overview.mockReset().mockResolvedValue({ characters: {}, modules: { mod: { enabled: true, copied: 3, failed: 0, retired: 2 } } })
})
afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    document.body.innerHTML = ''
})
async function render() {
    component = mount(ModuleAssetTransition, { target: document.body.appendChild(document.createElement('div')) })
    flushSync()
    await tick()
}
async function select(id: string) {
    const element = document.querySelector('select')!
    for (const option of element.options) option.selected = option.value === id
    const querySelector = element.querySelector.bind(element)
    vi.spyOn(element, 'querySelector').mockImplementation((selector: string) =>
        selector === ':checked' ? [...element.options].find(option => option.selected) ?? null : querySelector(selector))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
}
function button(label: string) {
    return [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)!
}

it('labels modules, enables actions from status, and reports V4 results', async () => {
    const base = { enabled: true, directory: 'Fate', copied: 3, failed: 0 }
    mocks.transition.mockImplementation(async (_id: string, action: string) => action === 'retire-kv'
        ? { ...base, kv: { retired: 2, bytes: 1048576 }, v4: { retired: 2, shared: 1, unverified: 0 } }
        : { ...base, kv: { retired: 0, bytes: 0 } })
    await render()
    await vi.waitFor(() => expect(document.querySelector('option[value="mod"]')?.textContent).toContain('[V4]'))
    expect(document.querySelector('option[value="mod"]')?.textContent).toBe('Fate (mod) / 에셋 3개 [V4]')
    await select('mod')
    expect(button('V4로 전환').disabled).toBe(true)
    button('상태 확인').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('폴더 사용 중: modules/Fate/assets'))
    expect(button('폴더 점검').disabled).toBe(false)
    button('V4로 전환').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('KV 목록에서 뺀 에셋 2개 (1.0MB)'))
    expect(document.body.textContent).toContain('이번 전환: 2개 이동 / 공유 에셋이라 유지 1개')
    expect(mocks.transition.mock.calls).toEqual([['mod', 'status'], ['mod', 'retire-kv']])
})

it('keeps the action failure visible and reads the status once', async () => {
    mocks.transition.mockRejectedValueOnce(new Error('busy'))
        .mockResolvedValueOnce({ enabled: false, directory: '', copied: 0, failed: 0, kv: { retired: 0, bytes: 0 } })
    await render()
    await select('twin')
    button('에셋 폴더 만들기').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('에셋 폴더 만들기를 완료하지 못했습니다'))
    expect(document.body.textContent).toContain('폴더 미사용')
    expect(mocks.transition.mock.calls).toEqual([['twin', 'migrate'], ['twin', 'status']])
})
