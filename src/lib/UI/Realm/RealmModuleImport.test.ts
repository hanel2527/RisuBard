import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { writable } from 'svelte/store'
import RealmPopUp from './RealmPopUp.svelte'

const mocks = vi.hoisted(() => ({ download: vi.fn(), import: vi.fn() }))
vi.mock('src/ts/realm/protonModule', async importOriginal => ({
    ...await importOriginal<typeof import('src/ts/realm/protonModule')>(), downloadProtonModule: mocks.download,
}))
vi.mock('src/ts/process/modules', () => ({ importRisum: mocks.import }))
vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: { language: 'ko', hideAllImages: true } } }))
vi.mock('src/lang', () => ({ language: { popularityLevelDesc: '', popularityLevel: '{}' } }))
vi.mock('src/ts/alert', () => ({ alertConfirm: vi.fn(), alertInput: vi.fn(), alertNormal: vi.fn(), notifyInfo: vi.fn() }))
vi.mock('src/ts/characterCards', () => ({ hubURL: '/hub', downloadRisuHub: vi.fn(), getRealmInfo: vi.fn() }))
vi.mock('src/ts/globalApi.svelte', () => ({ openURL: vi.fn() }))
vi.mock('src/ts/gui/tooltip', () => ({ tooltip: () => ({ destroy() {} }) }))
vi.mock('src/ts/gui/colorscheme', () => ({ ColorSchemeTypeStore: writable('dark') }))
vi.mock('src/ts/parser/parser.svelte', () => ({ ParseMarkdown: async () => '<p>Description</p>' }))
vi.mock('src/ts/util', () => ({ parseMultilangString: (value: string) => ({ xx: value }), toLangName: () => 'English' }))

const link = 'https://drive.proton.me/urls/9E36DKPTV8#fCpP3alN4tsR'
let mounted: ReturnType<typeof mount>
function button(label: string) { return [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label) }
async function render(desc = link) {
    mounted = mount(RealmPopUp, { target: document.body, props: { openedData: {
        id: 'test', name: 'Test bot', desc, tags: [], download: '1', license: '', creator: 'creator',
    } as never } })
    await tick()
}
beforeEach(() => { vi.resetAllMocks(); mocks.import.mockResolvedValue(undefined) })
afterEach(async () => { if (mounted) await unmount(mounted); document.body.replaceChildren() })

describe('Realm module button', () => {
    it('only shows the action for one unique Proton link', async () => {
        await render(`${link} https://drive.proton.me/urls/OTHER#key`)
        expect(button('모듈 가져오기')).toBeUndefined()
        expect(mocks.download).not.toHaveBeenCalled()
    })
    it('downloads only on click, imports once, and reports completion', async () => {
        const data = new Uint8Array([111, 0])
        mocks.download.mockResolvedValue({ kind: 'file', data })
        await render()
        expect(mocks.download).not.toHaveBeenCalled()
        button('모듈 가져오기')!.click()
        await vi.waitFor(() => expect(mocks.import).toHaveBeenCalledWith(data))
        await tick()
        expect(document.body.textContent).toContain('모듈을 가져왔습니다')
        expect(button('모듈 가져오기')!.disabled).toBe(true)
    })
    it('keeps folders external and presents a user-clickable original link', async () => {
        mocks.download.mockResolvedValue({ kind: 'external', reason: 'unsupported' })
        await render()
        button('모듈 가져오기')!.click()
        await vi.waitFor(() => expect(document.body.textContent).toContain('폴더 또는 지원하지 않는 파일'))
        expect(mocks.import).not.toHaveBeenCalled()
        expect(document.querySelector('a[target="_blank"]')?.getAttribute('href')).toBe(link)
    })
    it('allows retry after failure without reporting success', async () => {
        mocks.download.mockRejectedValue(new Error('network'))
        await render()
        button('모듈 가져오기')!.click()
        await vi.waitFor(() => expect(button('다시 시도')).toBeDefined())
        expect(mocks.import).not.toHaveBeenCalled()
        expect(document.body.textContent).not.toContain('모듈을 가져왔습니다')
    })
    it('prevents duplicate clicks and cancels a download before import', async () => {
        mocks.download.mockImplementation((_url, { signal, onProgress }) => new Promise((_resolve, reject) => {
            onProgress(50, 100)
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }))
        await render()
        const action = button('모듈 가져오기')!
        action.click()
        action.click()
        await tick()
        expect(mocks.download).toHaveBeenCalledTimes(1)
        expect(document.querySelector('progress')?.value).toBe(50)
        button('취소')!.click()
        await vi.waitFor(() => expect(button('모듈 가져오기')?.disabled).toBe(false))
        expect(mocks.import).not.toHaveBeenCalled()
    })
    it('shows retry when module persistence fails', async () => {
        mocks.download.mockResolvedValue({ kind: 'file', data: new Uint8Array([111, 0]) })
        mocks.import.mockRejectedValue(new Error('disk full'))
        await render()
        button('모듈 가져오기')!.click()
        await vi.waitFor(() => expect(button('다시 시도')).toBeDefined())
        expect(document.body.textContent).not.toContain('모듈을 가져왔습니다')
    })
})
