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
    it('runs all active characters sequentially and resumes from server status after remount', async () => {
        const enabled = new Set<string>(['active-a'])
        mocks.transition.mockImplementation(async (id, action) => {
            if (action === 'migrate') enabled.add(id)
            return { enabled: enabled.has(id), assets: { enabled: enabled.has(id), failed: 0 } }
        })
        await render()
        click('전체 캐릭터 V3 전환 / 재개')
        await vi.waitFor(() => expect(document.body.textContent).toContain('전체 처리 완료'))
        expect(mocks.transition.mock.calls).toEqual([
            ['active-a', 'status'], ['active-b', 'status'], ['active-b', 'migrate'],
        ])
        await unmount(component!)
        component = undefined
        mocks.transition.mockClear()
        await render()
        click('전체 캐릭터 V3 전환 / 재개')
        await vi.waitFor(() => expect(document.body.textContent).toContain('전체 처리 완료'))
        expect(mocks.transition.mock.calls).toEqual([['active-a', 'status'], ['active-b', 'status']])
    })

    it('isolates a failed character and reports asset failures without counting them as complete', async () => {
        mocks.transition.mockImplementation(async (id, action) => {
            if (id === 'active-a') throw new Error('unavailable')
            return { enabled: action === 'migrate', assets: { failed: 2 } }
        })
        await render()
        click('전체 캐릭터 V3 전환 / 재개')
        await vi.waitFor(() => expect(document.body.textContent).toContain('전체 처리 완료'))
        expect(mocks.transition.mock.calls).toEqual([
            ['active-a', 'status'], ['active-b', 'status'], ['active-b', 'migrate'],
        ])
        expect(document.body.textContent).toContain('상태 확인 또는 전환 실패')
        expect(document.body.textContent).toContain('에셋 2개 실패')
    })

    it('stops after the in-flight character and does not start another request', async () => {
        let resolveStatus!: (value: unknown) => void
        mocks.transition.mockImplementation(() => new Promise(resolve => { resolveStatus = resolve }))
        await render()
        click('전체 캐릭터 V3 전환 / 재개')
        await vi.waitFor(() => expect(mocks.transition).toHaveBeenCalledTimes(1))
        click('중단')
        resolveStatus({ enabled: false, assets: { failed: 0 } })
        await vi.waitFor(() => expect(document.body.textContent).toContain('전체 처리 중단'))
        expect(mocks.transition.mock.calls).toEqual([['active-a', 'status']])
    })

    it('rechecks deletion after status and excludes characters added after the batch starts', async () => {
        mocks.transition.mockImplementation(async () => {
            mocks.db.characters[0].trashTime = 123
            mocks.db.characters.push({ chaId: 'new', name: 'New' })
            return { enabled: true, assets: { enabled: true, failed: 0 } }
        })
        await render()
        click('전체 캐릭터 V3 전환 / 재개')
        await vi.waitFor(() => expect(document.body.textContent).toContain('전체 처리 완료'))
        expect(mocks.transition.mock.calls).toEqual([['active-a', 'status'], ['active-b', 'status']])
        expect(document.body.textContent).toContain('삭제되어 제외')
    })

    it('refreshes a mapped character whose assets failed on an earlier attempt', async () => {
        mocks.transition.mockImplementation(async (_id, action) => ({
            enabled: true, assets: { enabled: true, failed: action === 'status' ? 1 : 0 },
        }))
        await render()
        click('전체 캐릭터 V3 전환 / 재개')
        await vi.waitFor(() => expect(document.body.textContent).toContain('전체 처리 완료'))
        expect(mocks.transition.mock.calls).toEqual([
            ['active-a', 'status'], ['active-a', 'refresh'], ['active-b', 'status'], ['active-b', 'refresh'],
        ])
    })

    it('finishes only the current migration when leaving the settings screen', async () => {
        let finish!: (value: unknown) => void
        mocks.transition.mockImplementation(async (_id, action) => action === 'status'
            ? { enabled: false, assets: { enabled: false, failed: 0 } }
            : new Promise(resolve => { finish = resolve }))
        await render()
        click('전체 캐릭터 V3 전환 / 재개')
        await vi.waitFor(() => expect(mocks.transition).toHaveBeenCalledTimes(2))
        await unmount(component!)
        component = undefined
        finish({ enabled: true, assets: { enabled: true, failed: 0 } })
        await tick()
        expect(mocks.transition.mock.calls).toEqual([['active-a', 'status'], ['active-a', 'migrate']])
    })

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
