import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import CharacterAssetTransition from './CharacterAssetTransition.svelte'

const mocks = vi.hoisted(() => ({
    db: { characters: [] as { chaId: string; name: string; trashTime?: number }[] },
    transition: vi.fn(),
}))
vi.mock('src/ts/stores.svelte', () => ({ DBState: { get db() { return mocks.db } } }))
vi.mock('src/ts/platform', () => ({ isNodeServer: true }))
vi.mock('src/ts/globalApi.svelte', () => ({ forageStorage: {
    Init: vi.fn(async () => undefined),
    realStorage: { characterPackageTransition: mocks.transition },
} }))

let component: ReturnType<typeof mount> | undefined
async function render() {
    component = mount(CharacterAssetTransition, { target: document.body.appendChild(document.createElement('div')) })
    flushSync()
    await tick()
}
async function select(id: string) {
    const select = document.querySelector('select')!
    for (const option of select.options) {
        option.selected = option.value === id
    }
    // happy-dom does not implement :checked for selected <option> elements,
    // which Svelte uses to read a select binding.
    const querySelector = select.querySelector.bind(select)
    vi.spyOn(select, 'querySelector').mockImplementation((selector: string) =>
        selector === ':checked' ? [...select.options].find(option => option.selected) ?? null : querySelector(selector))
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
}
function click(label: string) {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === label)!
    expect(button.disabled).toBe(false)
    button.click()
}
beforeEach(() => {
    mocks.db.characters = [
        { chaId: 'active-a', name: 'Tanya' },
        { chaId: 'active-b', name: 'Tanya' },
        { chaId: 'deleted', name: 'Deleted', trashTime: 123 },
    ]
    mocks.transition.mockReset()
})
afterEach(async () => {
    if (component) await unmount(component)
    document.body.innerHTML = ''
})

describe('character V3 transition selection', () => {
    it('reports a failed migration and reads the resulting partial state once', async () => {
        mocks.transition.mockRejectedValueOnce(new Error('mapping failed'))
            .mockResolvedValueOnce({ enabled: false, directory: '', chats: 0,
                assets: { enabled: true, copied: 1, skipped: 0, failed: 0 },
                diagnostics: { reads: 0, fallbacks: 0 } })
        await render()
        await select('active-a')
        click('V3 구조로 전환')
        await vi.waitFor(() => expect(document.body.textContent).toContain('V3 전환을 완료하지 못했습니다'))
        expect(document.body.textContent).toContain('V3 폴더 전환 미완료')
        expect(mocks.transition.mock.calls).toEqual([['active-a', 'migrate'], ['active-a', 'status']])
    })

    it('retains action failure when the follow-up status request also fails', async () => {
        mocks.transition.mockRejectedValue(new Error('unavailable'))
        await render()
        await select('active-a')
        click('기존 구조로 되돌리기')
        await vi.waitFor(() => expect(mocks.transition).toHaveBeenCalledTimes(2))
        expect(document.body.textContent).toContain('기존 구조로 되돌리기를 완료하지 못했습니다')
        expect(document.body.textContent).toContain('현재 상태도 확인하지 못했습니다')
        expect(mocks.transition.mock.calls).toEqual([['active-a', 'rollback'], ['active-a', 'status']])
    })

    it('does not retry a failed status request', async () => {
        mocks.transition.mockRejectedValue(new Error('unavailable'))
        await render()
        await select('active-a')
        click('상태 확인')
        await vi.waitFor(() => expect(document.body.textContent).toContain('V3 전환 상태를 확인하지 못했습니다'))
        expect(mocks.transition.mock.calls).toEqual([['active-a', 'status']])
    })

    it('excludes deleted characters and distinguishes identically named active characters', async () => {
        await render()
        const options = [...document.querySelectorAll('option')].slice(1)
        expect(options.map(option => option.value)).toEqual(['active-a', 'active-b'])
        expect(new Set(options.map(option => option.textContent)).size).toBe(2)
    })

    it('does not migrate a character deleted after selection', async () => {
        await render()
        await select('active-a')
        mocks.db.characters[0].trashTime = 123
        click('V3 구조로 전환')
        await tick()
        expect(mocks.transition).not.toHaveBeenCalled()
    })

    it('identifies asset-only state as incomplete V3 transition', async () => {
        mocks.transition.mockResolvedValue({ enabled: false, directory: '', chats: 0,
            assets: { enabled: true, copied: 1, skipped: 0, failed: 0 },
            diagnostics: { reads: 0, fallbacks: 0 } })
        await render()
        await select('active-b')
        click('상태 확인')
        await vi.waitFor(() => expect(mocks.transition).toHaveBeenCalledWith('active-b', 'status'))
        await tick()
        expect(document.body.textContent).toContain('V3 폴더 전환 미완료')
        expect(document.body.textContent).toContain('에셋 복사본 읽기만 활성화')
        click('기존 구조로 되돌리기')
        await vi.waitFor(() => expect(mocks.transition).toHaveBeenLastCalledWith('active-b', 'rollback'))
    })

    it('clears the previous character status when a different character is selected', async () => {
        mocks.transition.mockResolvedValue({ enabled: true, directory: 'Tanya', chats: 3,
            assets: { enabled: true, copied: 1, skipped: 0, failed: 0 },
            diagnostics: { reads: 0, fallbacks: 0 } })
        await render()
        await select('active-a')
        click('상태 확인')
        await vi.waitFor(() => expect(document.body.textContent).toContain('V3 구조 사용 중'))
        await select('active-b')
        expect(document.body.textContent).not.toContain('V3 구조 사용 중')
        click('V3 구조로 전환')
        await vi.waitFor(() => expect(mocks.transition).toHaveBeenLastCalledWith('active-b', 'migrate'))
    })
})
