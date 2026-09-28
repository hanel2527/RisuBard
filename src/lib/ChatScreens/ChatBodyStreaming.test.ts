import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import { doingChat } from 'src/ts/process/generationState'
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
    doingChat.set(false)
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
    await Promise.resolve()
    await tick()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(yes => { resolve = yes })
    return { promise, resolve }
}

async function renderControlled(options: {
    html?: string
    role?: 'user' | 'char'
    chat?: Chat
    chatProvider?: () => Chat | undefined
    translated?: boolean
    translating?: boolean
    retranslate?: boolean
    renderRawStreaming?: boolean
    rawStreamingText?: string
} = {}) {
    const state = new SvelteMap<string, string | boolean>([
        ['html', options.html ?? '<p>Original message</p>'],
        ['translated', options.translated ?? false],
        ['translating', options.translating ?? false],
        ['retranslate', options.retranslate ?? false],
        ['renderRawStreaming', options.renderRawStreaming ?? false],
        ['rawStreamingText', options.rawStreamingText ?? ''],
    ])
    const target = document.createElement('div')
    document.body.append(target)
    if (options.chatProvider) {
        vi.mocked(getCurrentChat).mockImplementation(options.chatProvider)
    }
    else {
        vi.mocked(getCurrentChat).mockReturnValue(options.chat ?? {
            id: 'chat-a',
            autoTranslate: true,
        } as Chat)
    }
    mounted.push(mount(ChatBody, {
        target,
        props: {
            get msgDisplay() { return state.get('html') as string },
            get translated() { return state.get('translated') as boolean },
            set translated(value: boolean) { state.set('translated', value) },
            get translating() { return state.get('translating') as boolean },
            set translating(value: boolean) { state.set('translating', value) },
            get retranslate() { return state.get('retranslate') as boolean },
            set retranslate(value: boolean) { state.set('retranslate', value) },
            get renderRawStreaming() { return state.get('renderRawStreaming') as boolean },
            get rawStreamingText() { return state.get('rawStreamingText') as string },
            character: 'test',
            idx: 1,
            role: options.role ?? 'char',
            modelShortName: '',
            bodyRoot: target,
        },
    }))
    await settle()
    return { target, state }
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
        await vi.waitFor(() => {
            expect(target.querySelector('button[aria-label="본문에서 이미지 삭제"]')).not.toBeNull()
        })
        const button = target.querySelector<HTMLButtonElement>('button[aria-label="본문에서 이미지 삭제"]')!
        const image = target.querySelector('img')
        update(html.replace('One', 'One two'))
        await settle()
        expect(target.querySelector('img')).toBe(image)
        button.click()
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
    test('keeps the latest translation and translating state when an older request resolves late', async () => {
        Object.assign(DBState.db, { translatorType: 'llm' })
        const oldTranslation = deferred<string>()
        const latestTranslation = deferred<string>()
        let calls = 0
        vi.mocked(translateHTML).mockImplementation((html: string) => {
            calls += 1
            return calls === 1 ? oldTranslation.promise : latestTranslation.promise
        })
        const { target, state } = await renderControlled()
        expect(calls).toBe(1)
        expect(state.get('translating')).toBe(true)

        state.set('html', '<p>Latest message</p>')
        await settle()
        expect(calls).toBe(2)
        expect(state.get('translating')).toBe(true)

        oldTranslation.resolve('<p>Old translation</p>')
        await settle()
        expect(target.textContent).not.toContain('Old translation')
        expect(state.get('translating')).toBe(true)

        latestTranslation.resolve('<p>Latest translation</p>')
        await settle()
        expect(target.textContent).toBe('Latest translation')
        expect(state.get('translating')).toBe(false)
    })

    test('does not issue a duplicate request when the retranslate flag resets', async () => {
        Object.assign(DBState.db, { translatorType: 'llm' })
        const forcedTranslation = deferred<string>()
        let calls = 0
        vi.mocked(translateHTML).mockImplementation(() => {
            calls += 1
            return calls === 1
                ? Promise.resolve('<p>Initial translation</p>')
                : forcedTranslation.promise
        })
        const { target, state } = await renderControlled()
        expect(target.textContent).toBe('Initial translation')
        expect(calls).toBe(1)

        state.set('retranslate', true)
        await settle()
        expect(calls).toBe(2)
        forcedTranslation.resolve('<p>Forced translation</p>')
        await settle()
        expect(target.textContent).toBe('Forced translation')
        expect(calls).toBe(2)
    })

    test('retries a raw result once after generation ends', async () => {
        Object.assign(DBState.db, { translatorType: 'llm' })
        let generationActive = true
        vi.mocked(translateHTML).mockImplementation(async (html: string) => (
            generationActive ? html : '<p>Translated after generation</p>'
        ))
        doingChat.set(true)
        const { target } = await renderControlled()
        expect(target.textContent).toBe('Original message')
        expect(translateHTML).toHaveBeenCalledTimes(1)

        generationActive = false
        doingChat.set(false)
        await settle()
        expect(translateHTML).toHaveBeenCalledTimes(2)
        expect(target.textContent).toBe('Translated after generation')
    })

    test('translates the completed message when strong raw streaming display ends', async () => {
        Object.assign(DBState.db, { translatorType: 'llm' })
        vi.mocked(translateHTML).mockResolvedValue('<p>Final translation</p>')
        const { target, state } = await renderControlled({
            html: '<p>Partial response</p>',
            renderRawStreaming: true,
            rawStreamingText: 'Partial response',
        })
        expect(target.textContent).toBe('Partial response')
        expect(translateHTML).not.toHaveBeenCalled()

        state.set('html', '<p>Final response</p>')
        state.set('renderRawStreaming', false)
        state.set('rawStreamingText', 'Final response')
        await settle()
        expect(translateHTML).toHaveBeenCalledTimes(1)
        expect(target.textContent).toBe('Final translation')
    })

    test('does not let a late result from the previous chat replace the current chat', async () => {
        Object.assign(DBState.db, { translatorType: 'llm' })
        const oldTranslation = deferred<string>()
        const currentTranslation = deferred<string>()
        const oldChat = { id: 'chat-old', autoTranslate: true } as Chat
        const currentChat = { id: 'chat-current', autoTranslate: true } as Chat
        const chats = new SvelteMap<string, Chat>([['current', oldChat]])
        let calls = 0
        vi.mocked(translateHTML).mockImplementation(() => {
            calls += 1
            return calls === 1 ? oldTranslation.promise : currentTranslation.promise
        })
        const { target, state } = await renderControlled({
            chatProvider: () => chats.get('current'),
        })
        expect(calls).toBe(1)
        chats.set('current', currentChat)
        state.set('html', '<p>Current chat message</p>')
        await settle()
        expect(calls).toBe(2)

        oldTranslation.resolve('<p>Previous chat translation</p>')
        await settle()
        expect(target.textContent).not.toContain('Previous chat translation')

        currentTranslation.resolve('<p>Current chat translation</p>')
        await settle()
        expect(target.textContent).toBe('Current chat translation')
    })
})
