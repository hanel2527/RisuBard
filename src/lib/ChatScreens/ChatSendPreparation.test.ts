import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}

// Run the component's real send functions with only external work replaced.
function screen(overrides: Record<string, unknown> = {}) {
    const source = readFileSync('src/lib/ChatScreens/DefaultChatScreen.svelte', 'utf8')
    const script = source.slice(source.indexOf('>') + 1, source.indexOf('</script>'))
    const parsed = ts.createSourceFile('screen.ts', script, ts.ScriptTarget.Latest, true)
    const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node)
        && ['sendMain', 'sendChatMain'].includes(node.name?.text ?? ''))
    const code = ts.transpileModule(functions.map(node => node.getText(parsed)).join('\n'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText
    const chat = { id: 'chat-1', message: [] as unknown[] }
    const errors: unknown[] = []
    const calls: string[] = []
    const dependencies = {
        $selectedCharID: 0, $doingChat: false, wikiRebootBlocksGeneration: false, currentChatGenerating: false,
        language: {}, DBState: { db: { characters: [{ type: 'character', chatPage: 0, chats: [chat] }] } },
        ensureActiveChatReady: async () => chat,
        runTrigger: async () => undefined,
        processScript: async (_: unknown, text: string) => text,
        processMultiCommand: async () => false,
        removeChatDraft: () => {}, draftChaId: 'character-1', draftChatId: 'chat-1',
        getLatestChatPage: () => 0, chatPageSize: 20,
        sleep: async () => {}, updateInputSizeAll: () => {},
        currentChatGenKey: () => chat.id, $generationStates: new Map(),
        registerAbort: () => {}, endGeneration: () => {}, clearPendingSend: () => {},
        sendChat: async () => { calls.push('request'); return true },
        playNotificationSound: () => {}, alertError: (error: unknown) => errors.push(error),
        console: { error: () => {} },
        ...overrides,
    }
    const api = new Function(...Object.keys(dependencies), `
        let messageInput = 'original input', fileInput = [], chatPage = 0;
        let preparingInput = false, sendingChat = false, sendingChatKey = null;
        ${code}
        return {sendMain, sendChatMain, state: () => ({messageInput, preparingInput, sendingChat})};
    `)(...Object.values(dependencies))
    return { ...api, chat, errors, calls }
}

describe('chat send preparation', () => {
    it('blocks a second click while input translation is pending', async () => {
        const translation = deferred<string>()
        const chat = screen({ processScript: () => translation.promise })
        const first = chat.sendMain(false)
        await vi.waitFor(() => expect(chat.state().preparingInput).toBe(true))
        await chat.sendMain(false)
        translation.resolve('translated input')
        await first
        expect(chat.chat.message).toHaveLength(1)
        expect(chat.calls).toEqual(['request'])
        expect(chat.state().preparingInput).toBe(false)
    })

    it('keeps the draft and permits retry after an input hook fails', async () => {
        let fail = true
        const chat = screen({ processScript: async () => {
            if (fail) throw new Error('translation failed')
            return 'translated input'
        } })
        await expect(chat.sendMain(false)).resolves.toBeUndefined()
        expect(chat.errors).toHaveLength(1)
        expect(chat.state()).toMatchObject({messageInput: 'original input', preparingInput: false})
        expect(chat.chat.message).toHaveLength(0)
        fail = false
        await chat.sendMain(false)
        expect(chat.chat.message).toHaveLength(1)
    })

    it('blocks duplicate requests before generation registration and unlocks on failure', async () => {
        const pending = deferred<boolean>()
        let requests = 0
        const chat = screen({ sendChat: () => { requests++; return pending.promise } })
        const first = chat.sendChatMain()
        expect(chat.state().sendingChat).toBe(true)
        expect(await chat.sendChatMain()).toBe(false)
        expect(requests).toBe(1)
        pending.reject(new Error('sync failed'))
        expect(await first).toBe(false)
        expect(chat.state().sendingChat).toBe(false)
    })
})
