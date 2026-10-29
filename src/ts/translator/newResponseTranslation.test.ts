import { beforeEach, expect, test, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import type { character, Chat, Database } from '../storage/database.svelte'

const state = vi.hoisted(() => ({
    db: {} as Database,
    storage: new Map<string, unknown>(),
    request: vi.fn(),
    error: vi.fn(),
}))
vi.mock('../stores.svelte', () => ({
    DBState: state,
    selectedCharID: writable(0),
    ReloadChatPointer: writable({}),
    createSimpleCharacter: (char: character) => ({ type: 'simple', chaId: char.chaId, customscript: [] }),
}))
vi.mock('../storage/database.svelte', () => ({ getDatabase: () => state.db }))
vi.mock('../process/index.svelte', () => ({ doingChat: writable(true) }))
vi.mock('../process/request/request', () => ({ requestChatData: state.request }))
vi.mock('../alert', () => ({ notifyError: state.error }))
vi.mock('../globalApi.svelte', () => ({ globalFetch: vi.fn() }))
vi.mock('../parser/parser.svelte', () => ({
    risuChatParser: (text: string) => text,
    ParseMarkdown: async (text: string) => text,
    applyMarkdownToNode: vi.fn(),
}))
vi.mock('../process/modules', () => ({ getModuleRegexScripts: () => [] }))
vi.mock('../process/scripts', () => ({ processScriptFull: vi.fn() }))
vi.mock('../util', () => ({ getNodetextToSentence: vi.fn(), sleep: vi.fn() }))
vi.mock('../notificationSound', () => ({ playNotificationSound: vi.fn() }))
vi.mock('../storage/persistentKv', () => ({
    listPersistentKeys: async () => [...state.storage.keys()],
    readPersistentJson: async (key: string) => state.storage.get(key) ?? null,
    readPersistentJsonWithVersion: async (key: string) => ({ value: state.storage.get(key) ?? null, etag: null }),
    makeHashedStorageKey: async (prefix: string, key: string) => prefix + key,
    writePersistentJson: async (key: string, value: unknown) => { state.storage.set(key, value) },
    writePersistentJsonConditional: async (key: string, value: unknown) => { state.storage.set(key, value); return 'saved' },
    removePersistentKeyConditional: async (key: string) => { state.storage.delete(key) },
    clearPersistentPrefix: async () => { state.storage.clear() },
}))

import { ReloadChatPointer, selectedCharID } from '../stores.svelte'
import { clearLLMCache, getLLMCache, translateHTML } from './translator'
import { translateNewResponse } from './newResponseTranslation'

let bot: character
let chat: Chat
const signal = () => new AbortController().signal

beforeEach(async () => {
    await clearLLMCache()
    vi.clearAllMocks()
    chat = { id: 'chat-a', message: [
        { chatId: 'old', role: 'char', data: 'Old English response' },
        { chatId: 'user', role: 'user', data: '한국어 입력' },
        { chatId: 'new', role: 'char', data: 'New English response' },
    ] } as Chat
    bot = { chaId: 'bot-a', name: 'A', chatPage: 0, chats: [chat], customscript: [], translatorNote: 'Bot A note' } as character
    state.db = {
        characters: [bot], autoTranslate: true, translator: 'ko', translatorInputLanguage: 'en',
        translatorType: 'llm', autoTranslateCachedOnly: true, translateBeforeHTMLFormatting: true,
    } as Database
    selectedCharID.set(0)
    ReloadChatPointer.set({})
    state.request.mockResolvedValue({ type: 'success', result: '새 한국어 응답' })
})

test('publishes only the completed AI response while generation is still active', async () => {
    // Normal rendering must still refuse an uncached translation during generation.
    expect(await translateHTML(chat.message[2].data, false, '', 2)).toBe('New English response')
    expect(state.request).not.toHaveBeenCalled()
    const before = structuredClone(chat.message)
    await translateNewResponse(bot, chat, 'new', signal())
    expect(await getLLMCache('New English response')).toBe('새 한국어 응답')
    expect(await getLLMCache('Old English response')).toBeNull()
    expect(await getLLMCache('한국어 입력')).toBeNull()
    expect(chat.message).toEqual(before)
    expect(get(ReloadChatPointer)).toEqual({ 2: 1 })
    // Rendering/revisiting consumes the cache, not another paid request.
    expect(await translateHTML('New English response', false, '', 2)).toBe('새 한국어 응답')
    expect(state.request).toHaveBeenCalledTimes(1)
})

test.each(['bot-off', 'auto-off', 'language-off', 'user', 'aborted', 'deleted', 'comment'])(
    'does not create a translation for %s', async mode => {
        const abort = new AbortController()
        let id = 'new'
        if (mode === 'bot-off') bot.autoTranslateNewResponses = false
        if (mode === 'auto-off') state.db.autoTranslate = false
        if (mode === 'language-off') state.db.translator = ''
        if (mode === 'user') id = 'user'
        if (mode === 'aborted') abort.abort()
        if (mode === 'deleted') id = 'deleted'
        if (mode === 'comment') chat.message[2].isComment = true
        await translateNewResponse(bot, chat, id, abort.signal)
        expect(state.request).not.toHaveBeenCalled()
        expect(await getLLMCache('New English response')).toBeNull()
        expect(get(ReloadChatPointer)).toEqual({})
    },
)

test('finishes cache publication before its caller can start wiki work', async () => {
    // The project's TypeScript lib predates Promise.withResolvers.
    let finish!: (value: unknown) => void
    const promise = new Promise<unknown>(resolve => { finish = resolve })
    state.request.mockReturnValue(promise)
    let wikiStarted = false
    const completion = (async () => {
        await translateNewResponse(bot, chat, 'new', signal())
        wikiStarted = true
        expect(await getLLMCache('New English response')).toBe('번역 완료')
    })()
    await vi.waitFor(() => expect(state.request).toHaveBeenCalledOnce())
    expect(wikiStarted).toBe(false)
    finish({ type: 'success', result: '번역 완료' })
    await completion
    expect(wikiStarted).toBe(true)
})

test.each(['provider', 'exception'])('keeps original content and releases the caller on %s failure', async mode => {
    if (mode === 'provider') state.request.mockResolvedValue({ type: 'fail', result: 'Unavailable' })
    else state.request.mockRejectedValue(new Error('Unavailable'))
    await translateNewResponse(bot, chat, 'new', signal())
    expect(chat.message[2].data).toBe('New English response')
    expect(await getLLMCache('New English response')).toBeNull()
    expect(state.error).toHaveBeenCalledWith('Unavailable')
})

test('keeps the originating bot note and never redraws a newly selected chat', async () => {
    const other = { chaId: 'bot-b', chatPage: 0, translatorNote: 'Bot B note', chats: [{ id: 'chat-b', message: [] }] } as unknown as character
    state.db.characters.push(other)
    selectedCharID.set(1)
    state.db.translatorPrompt = '{{slot::tnote}}'
    await translateNewResponse(bot, chat, 'new', signal())
    expect(await getLLMCache('New English response')).toBe('새 한국어 응답')
    expect(get(ReloadChatPointer)).toEqual({})
    expect(JSON.stringify(state.request.mock.calls[0])).not.toContain('Bot B note')
    expect(JSON.stringify(state.request.mock.calls[0])).toContain('Bot A note')
})
