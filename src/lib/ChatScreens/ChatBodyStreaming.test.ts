import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import ChatBody from './ChatBody.svelte'
import { ParseMarkdown } from 'src/ts/parser/parser.svelte'
import { DBState } from 'src/ts/stores.svelte'
import { getCurrentChat, type Chat } from 'src/ts/storage/database.svelte'
import { getLLMCache, translateHTML } from 'src/ts/translator/translator'

vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: {} } }))
vi.mock('src/ts/util', () => ({ sleep: async () => {} }))
vi.mock('src/ts/alert', () => ({ alertError: vi.fn() }))
vi.mock('src/ts/translator/translator', () => ({ getLLMCache: vi.fn(), translateHTML: vi.fn() }))
vi.mock('src/ts/process/modules', () => ({ getModuleAssets: () => [] }))
vi.mock('src/ts/storage/database.svelte', () => ({ getCurrentCharacter: () => ({}), getCurrentChat: vi.fn() }))
vi.mock('src/ts/globalApi.svelte', () => ({ getFileSrc: vi.fn() }))
vi.mock('src/ts/parser/parser.svelte', () => ({
    ParseMarkdown: vi.fn(async (text: string) => text),
    addMetadataToElement: (html: string) => html,
    trimMarkdown: (html: string) => html,
    postTranslationParse: (html: string) => html,
    getDistance: vi.fn(),
    resolveInlayPlaceholders: (root: HTMLElement) => {
        for (const placeholder of root.querySelectorAll('[data-inlay-id]')) {
            const image = document.createElement('img')
            image.src = `https://example.test/${placeholder.getAttribute('data-inlay-id')}.png`
            placeholder.replaceWith(image)
        }
    },
}))

const mounted: ReturnType<typeof mount>[] = []
beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
    for (const component of mounted.splice(0)) await unmount(component)
    document.body.replaceChildren()
    vi.mocked(ParseMarkdown).mockReset().mockImplementation(async text => text)
    vi.mocked(getCurrentChat).mockReset()
    vi.mocked(getLLMCache).mockReset()
    vi.mocked(translateHTML).mockReset()
    for (const key of Object.keys(DBState.db)) delete DBState.db[key]
    vi.useRealTimers()
})

async function settle() {
    await tick()
    await Promise.resolve()
    await tick()
    await Promise.resolve()
    await tick()
    await vi.advanceTimersByTimeAsync(10)
    await tick()
}

async function render(html: string, onRemoveInlay?: (id: string, occurrence: number) => void) {
    const state = new SvelteMap([['html', html]])
    const target = document.createElement('div')
    document.body.append(target)
    mounted.push(mount(ChatBody, {
        target,
        props: {
            get msgDisplay() { return state.get('html')! },
            idx: 1, character: 'test', role: 'char', translated: false,
            retranslate: false, translating: false, modelShortName: '', bodyRoot: target,
            onRemoveInlay,
        },
    }))
    await settle()
    return { target, update: (html: string) => state.set('html', html) }
}

describe('streaming chat body', () => {
    test('offers an accessible removal control for an editable inlay and retains it across text updates', async () => {
        const remove = vi.fn()
        const html = '<p><img data-inlay-image-id="scene" data-inlay-occurrence="1" src="https://example.test/a.png">One</p>'
        const { target, update } = await render(html, remove)
        const button = target.querySelector<HTMLButtonElement>('button[aria-label="본문에서 이미지 삭제"]')
        expect(button).not.toBeNull()
        const image = target.querySelector('img')
        update(html.replace('One', 'One two'))
        await settle()
        expect(target.querySelector('img')).toBe(image)
        button!.click()
        expect(remove).toHaveBeenCalledWith('scene', 1)
    })

    test('does not offer removal for ordinary images or read-only inlays', async () => {
        const { target } = await render('<p><img data-inlay-image-id="scene" data-inlay-occurrence="0" src="https://example.test/a.png"></p>')
        expect(target.querySelector('button')).toBeNull()
        const editable = await render('<p><img src="https://example.test/a.png"></p>', vi.fn())
        expect(editable.target.querySelector('button')).toBeNull()
    })
    test('keeps loaded images and existing text nodes while parsing and appending tokens', async () => {
        const { target, update } = await render('<p><img src="https://example.test/a.png">Hello</p>')
        const paragraph = target.querySelector('p')!
        const image = target.querySelector('img')!
        const text = paragraph.lastChild!
        let finish!: (html: string) => void
        vi.mocked(ParseMarkdown).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
        update('next chunk')
        await settle()
        expect(target.querySelector('p')).toBe(paragraph)
        expect(target.querySelector('img')).toBe(image)
        finish('<p><img src="https://example.test/a.png">Hello world</p>')
        await settle()
        expect(target.querySelector('img')).toBe(image)
        expect(paragraph.lastChild).toBe(text)
        expect(target.textContent).toBe('Hello world')
    })

    test('retains resolved inlays when text in the same paragraph grows', async () => {
        const { target, update } = await render('<p><span data-inlay-id="scene"></span>One</p>')
        const image = target.querySelector('img')!
        expect(image).not.toBeNull()
        update('<p><span data-inlay-id="scene"></span>One two</p>')
        await settle()
        expect(target.querySelector('img')).toBe(image)
        expect(target.textContent).toBe('One two')
    })

    test('applies edits and image changes without retaining deleted content', async () => {
        const { target, update } = await render('<p class="old"><img src="https://example.test/a.png">Old</p><p>Remove me</p>')
        update('<p class="new"><img src="https://example.test/b.png">New <strong>text</strong></p>')
        await settle()
        expect(target.querySelectorAll('p')).toHaveLength(1)
        expect(target.querySelector('p')?.className).toBe('new')
        expect(target.querySelector('img')?.getAttribute('src')).toBe('https://example.test/b.png')
        expect(target.textContent).toBe('New text')
    })

    test('keeps adjacent content when an inlay becomes a hidden placeholder', async () => {
        const { target, update } = await render('<p><span data-inlay-id="scene"></span>One</p>')
        const paragraph = target.querySelector('p')!
        const text = paragraph.lastChild
        target.querySelector('img')!.replaceWith(document.createComment('hidden inlay'))
        update('<p><span data-inlay-id="scene"></span>One two</p>')
        await settle()
        expect(target.querySelector('p')).toBe(paragraph)
        expect(paragraph.lastChild).toBe(text)
        expect(target.querySelector('img, [data-inlay-id]')).toBeNull()
        expect(target.textContent).toBe('One two')
    })

    test('ignores late parser results from an older streaming update', async () => {
        const { target, update } = await render('<p>Initial</p>')
        let finishOld!: (html: string) => void
        vi.mocked(ParseMarkdown).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
        update('slow chunk')
        await settle()
        update('<p>Newest</p>')
        await settle()
        finishOld('<p>Outdated</p>')
        await settle()
        expect(target.textContent).toBe('Newest')
    })
})

async function renderTranslation(role: 'user' | 'char', options: { global?: boolean, local?: boolean, cachedOnly?: boolean } = {}) {
    const settings = new SvelteMap<string, boolean | undefined>([
        ['global', options.global ?? true], ['local', options.local],
    ])
    Object.defineProperty(DBState.db, 'autoTranslate', {
        configurable: true, enumerable: true, get: () => settings.get('global'),
    })
    Object.assign(DBState.db, { translatorType: 'llm', autoTranslateCachedOnly: !!options.cachedOnly })
    vi.mocked(getCurrentChat).mockReturnValue({
        id: 'chat-a', get autoTranslate() { return settings.get('local') },
    } as Chat)
    vi.mocked(translateHTML).mockResolvedValue('<p>번역된 메시지</p>')
    const state = new SvelteMap<string, boolean>([['translated', false]])
    const target = document.createElement('div')
    document.body.append(target)
    mounted.push(mount(ChatBody, {
        target, props: {
            msgDisplay: '<p>Original message</p>', character: 'test', idx: 1, role,
            get translated() { return state.get('translated')! },
            retranslate: false, translating: false, modelShortName: '', bodyRoot: target,
        },
    }))
    await settle()
    return { target, settings, manualTranslate: () => state.set('translated', true) }
}

describe('chat automatic translation', () => {
    test('leaves user messages original, including cached ones, but allows manual translation', async () => {
        vi.mocked(getLLMCache).mockResolvedValue('cached')
        const { target, manualTranslate } = await renderTranslation('user', { cachedOnly: true })
        expect(target.textContent).toBe('Original message')
        expect(translateHTML).not.toHaveBeenCalled()
        expect(getLLMCache).not.toHaveBeenCalled()
        manualTranslate()
        await settle()
        expect(target.textContent).toBe('번역된 메시지')
    })

    test('applies chat overrides live without changing the global default', async () => {
        const { target, settings } = await renderTranslation('char')
        expect(target.textContent).toBe('번역된 메시지')
        settings.set('local', false)
        await settle()
        expect(target.textContent).toBe('Original message')
        expect(settings.get('global')).toBe(true)
        settings.set('global', false)
        settings.set('local', true)
        await settle()
        expect(target.textContent).toBe('번역된 메시지')
    })

    test('allows manual translation while this chat opts out of automatic translation', async () => {
        const { target, manualTranslate } = await renderTranslation('char', { local: false })
        expect(target.textContent).toBe('Original message')
        expect(translateHTML).not.toHaveBeenCalled()
        manualTranslate()
        await settle()
        expect(target.textContent).toBe('번역된 메시지')
    })

    test('does not enable translation after a pending cache lookup when the chat is turned off', async () => {
        let resolveCache!: (value: string) => void
        // The project targets ES2023, before Promise.withResolvers.
        vi.mocked(getLLMCache).mockImplementationOnce(() => new Promise(resolve => { resolveCache = resolve }))
        const { target, settings } = await renderTranslation('char', { cachedOnly: true })
        settings.set('local', false)
        await settle()
        resolveCache('cached')
        await settle()
        expect(target.textContent).toBe('Original message')
        expect(translateHTML).not.toHaveBeenCalled()
    })
})
