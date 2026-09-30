import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Exercise the real request loop without loading browser/network dependencies.
function requestHarness() {
    const source = readFileSync('src/ts/process/request/request.ts', 'utf8')
    const parsed = ts.createSourceFile('request.ts', source, ts.ScriptTarget.Latest, true)
    const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node)
        && node.name?.text === 'requestChatData')!
    const code = ts.transpileModule(declaration.getText(parsed), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText.replace(/^export /m, '')
    const target = { id: 'target', message: [{ role: 'user', data: 'target history' }] }
    const visible = { id: 'visible', message: [{ role: 'user', data: 'visible history' }] }
    const character = { chaId: 'character', chatPage: 1, chats: [target, visible] }
    const db = { characters: [character], requestRetrys: 0 }
    const dependencies = {
        getDatabase: () => db,
        normalizeRequestRetryLimit: (value: number) => value,
        createModelAttemptOrder: () => [''],
        safeStructuredClone: structuredClone,
        getTools: async () => [],
        risuUnescape: (value: string) => value,
        pluginV2: { replacerbeforeRequest: new Set(), replacerafterRequest: new Set() },
        exports: {},
        getCurrentCharacter: () => character,
        runTrigger: async (_character: unknown, _event: string, input: {
            chat: typeof target; displayData: string
        }) => {
            input.chat.message.push({ role: 'user', data: 'trigger effect' })
            const prompt = JSON.parse(input.displayData)
            prompt.push({ role: 'system', content: 'trigger instruction' })
            return { displayData: JSON.stringify(prompt) }
        },
        requestChatDataMain: async (input: { formated: unknown[] }) => ({
            type: 'success', result: JSON.stringify(input.formated), model: 'smoke',
        }),
        console: { log() {}, warn() {}, error() {} },
    }
    const request = new Function(...Object.keys(dependencies), `${code}; return requestChatData;`)(
        ...Object.values(dependencies)
    ) as (input: unknown, mode: string) => Promise<{ result: string }>
    const input = (realChatId: string) => ({
        currentChar: character, realChatId, tools: [], requestSettings: db,
        formated: [{ role: 'user', content: 'request' }],
    })
    return { request, input, target, visible }
}

describe('request trigger chat scope', () => {
    it('does not mutate the visible chat after the captured chat is switched away', async () => {
        const harness = requestHarness()
        const response = await harness.request(harness.input('target'), 'model')
        expect(harness.target.message.map(message => message.data)).toEqual([
            'target history', 'trigger effect',
        ])
        expect(harness.visible.message.map(message => message.data)).toEqual(['visible history'])
        expect(JSON.parse(response.result)).toEqual([
            { role: 'user', content: 'request' },
            { role: 'system', content: 'trigger instruction' },
        ])
    })

    it('keeps standalone translation from executing chat-changing triggers', async () => {
        const harness = requestHarness()
        const response = await harness.request(harness.input('target'), 'translate')
        expect(harness.target.message.map(message => message.data)).toEqual(['target history'])
        expect(harness.visible.message.map(message => message.data)).toEqual(['visible history'])
        expect(JSON.parse(response.result)).toEqual([{ role: 'user', content: 'request' }])
    })

    it('does not substitute the visible chat when the captured chat was removed', async () => {
        const harness = requestHarness()
        await harness.request(harness.input('deleted'), 'model')
        expect(harness.target.message.map(message => message.data)).toEqual(['target history'])
        expect(harness.visible.message.map(message => message.data)).toEqual(['visible history'])
    })
})
