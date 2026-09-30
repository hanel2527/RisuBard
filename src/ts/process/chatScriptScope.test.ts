import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'

const state = vi.hoisted(() => ({ db: null as any, wait: null as Promise<void> | null }))
vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => state.db,
    getCurrentCharacter: () => state.db.characters[0],
    getCurrentChat: () => state.db.characters[0].chats[state.db.characters[0].chatPage],
    setCurrentCharacter: (char: unknown) => { state.db.characters[0] = char },
    setDatabase: () => {},
}))
vi.mock('../stores.svelte', () => ({
    ReloadChatPointer: writable({}), ReloadGUIPointer: writable(0), selectedCharID: writable(0),
    CurrentTriggerIdStore: writable(null), CharEmotion: writable({}),
}))
vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (value: string) => value, assetRegex: /asset/g }))
vi.mock('../parser/chatML', () => ({ parseChatML: vi.fn() }))
vi.mock('../tokenizer', () => ({ tokenize: async () => 0 }))
vi.mock('./modules', () => ({ getModuleTriggers: () => [], getModuleRegexScripts: () => [], getModuleAssets: () => [] }))
vi.mock('./tts', () => ({ sayTTS: vi.fn() }))
vi.mock('./index.svelte', () => ({ sendChat: vi.fn() }))
vi.mock('./lorebook.svelte', () => ({ loadLoreBookV3Prompt: vi.fn() }))
vi.mock('../util', () => ({ parseKeyValue: () => [], sleep: () => state.wait, selectSingleFile: vi.fn() }))
vi.mock('../alert', () => ({ alertError: vi.fn(), alertInput: async () => { await state.wait; return 'A value' }, alertMd: vi.fn(), alertNormal: vi.fn(), alertSelect: vi.fn(), notifySuccess: vi.fn() }))
vi.mock('./memory/hypamemory', () => ({ HypaProcesser: class {} }))
vi.mock('./request/request', () => ({ requestChatData: vi.fn() }))
vi.mock('./request/shared', () => ({ collectStreamingText: vi.fn() }))
vi.mock('./stableDiff', () => ({ generateAIImage: vi.fn() }))
vi.mock('./files/inlays', () => ({ writeInlayImage: vi.fn() }))
vi.mock('./scriptings', () => ({ runScripted: vi.fn(), runLuaEditTrigger: async (_char: unknown, _mode: unknown, data: string) => { await state.wait; return data } }))
vi.mock('./infunctions', () => ({ calcString: vi.fn() }))
vi.mock('../globalApi.svelte', () => ({ downloadFile: vi.fn() }))
vi.mock('../plugins/plugins.svelte', () => ({ pluginV2: { editoutput: new Set() } }))
vi.mock('src/lang', () => ({ language: {} }))

import { runTrigger } from './triggers'
import { processScriptFull, resetScriptCache } from './scripts'
import { processMultiCommand } from './command'

function deferred() {
    let resolve!: () => void
    state.wait = new Promise<void>((done) => { resolve = done })
    return resolve
}

beforeEach(() => {
    vi.stubGlobal('safeStructuredClone', structuredClone)
    state.wait = null
    state.db = { templateDefaultVariables: '', presetRegex: [], characters: [{
        type: 'character', chaId: 'bot', chatPage: 0, defaultVariables: '', triggerscript: [], customscript: [],
        chats: ['A', 'B'].map(id => ({ id, name: id, message: [{ role: 'char', data: id }], scriptstate: { $owner: id } })),
    }] }
    resetScriptCache()
})

describe('chat script scope while switching chats', () => {
    it('keeps A preset output rules after switching to B during Lua processing', async () => {
        const char = state.db.characters[0]
        state.db.presetRegex = [{ type: 'editoutput', in: 'answer', out: 'A preset' }]
        const requestSettings = { ...state.db, characters: [] }
        const finish = deferred()
        const running = processScriptFull(char, 'answer', 'editoutput', 0, {}, { characterId: 'bot', chatId: 'A' }, requestSettings)
        char.chatPage = 1
        state.db.presetRegex = [{ type: 'editoutput', in: 'answer', out: 'B preset' }]
        finish()
        expect((await running).data).toBe('A preset')
        expect(char.chats[1].message[0].data).toBe('B')
    })

    it('keeps command pipeline writes on A after waiting for input and switching to B', async () => {
        const char = state.db.characters[0]
        const finish = deferred()
        const running = processMultiCommand('/input question | /setvar key=owner', { character: char, chat: char.chats[0] })
        char.chatPage = 1
        finish()
        await running
        expect(char.chats[0].scriptstate.$owner).toBe('A value')
        expect(char.chats[1].scriptstate.$owner).toBe('B')
    })
    it('keeps trigger variables and author notes on A after an asynchronous effect', async () => {
        const char = state.db.characters[0]
        char.triggerscript = [{ type: 'output', conditions: [], effect: [
            { type: 'v2Wait', valueType: 'value', value: '1' },
            { type: 'setvar', var: 'owner', value: 'A updated', operator: '=' },
            { type: 'v2SetAuthorNote', valueType: 'value', value: 'A note' },
        ] }]
        const finish = deferred()
        const running = runTrigger(char, 'output', { chat: char.chats[0] })
        char.chatPage = 1
        finish()
        await running
        expect(char.chats[0].scriptstate.$owner).toBe('A updated')
        expect(char.chats[0].note).toBe('A note')
        expect(char.chats[1].scriptstate.$owner).toBe('B')
        expect(char.chats[1].note).toBeUndefined()
    })

    it('preserves the live chat list and selection when a trigger edits character data', async () => {
        const char = state.db.characters[0]
        char.triggerscript = [{ type: 'output', conditions: [], effect: [
            { type: 'v2Wait', valueType: 'value', value: '1' },
            { type: 'v2SetCharacterDesc', valueType: 'value', value: 'updated description' },
        ] }]
        const finish = deferred()
        const running = runTrigger(char, 'output', { chat: char.chats[0] })
        char.chatPage = 1
        char.chats[1].message.push({ role: 'user', data: 'B draft sent' })
        finish()
        await running
        const live = state.db.characters[0]
        expect(live.desc).toBe('updated description')
        expect(live.chatPage).toBe(1)
        expect(live.chats[1].message.at(-1).data).toBe('B draft sent')
    })

    it('injects output into A after switching to B during Lua processing', async () => {
        const char = state.db.characters[0]
        char.customscript = [{ type: 'editoutput', in: 'answer', out: '@@inject' }]
        const finish = deferred()
        const running = processScriptFull(char, 'answer', 'editoutput', 0, {}, { characterId: 'bot', chatId: 'A' })
        char.chatPage = 1
        finish()
        await running
        expect(char.chats[0].message[0].data).toBe('answer')
        expect(char.chats[1].message[0].data).toBe('B')
    })
})
