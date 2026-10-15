import { beforeEach, describe, expect, it, vi } from 'vitest'

const requests: { formated: { role: string; content: string }[] }[] = []
const replies: string[] = []

vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (text: string) => text }))
vi.mock('../util', () => ({ parseToggleSyntax: () => [] }))
vi.mock('../storage/database.svelte', () => ({
    getActiveBotPresetId: () => '',
    getActivePromptOverlayToggleTemplate: () => '',
    getBotPresetById: () => undefined,
    getDatabase: () => ({ characters: [] }),
    snapshotCurrentToggleValues: () => ({}),
}))
vi.mock('../storage/persistentKv', () => ({ readPersistentJson: vi.fn(), removePersistentKey: vi.fn(), writePersistentJson: vi.fn() }))
vi.mock('../process/modules', () => ({ getModules: () => [] }))
vi.mock('./promptAssistantStore', () => ({ collectPromptAssistantChatLines: () => [] }))
vi.mock('../process/request/request', () => ({
    requestChatData: vi.fn(async (arg: { formated: { role: string; content: string }[] }) => {
        requests.push(arg)
        return { type: 'success', result: replies.shift() ?? '' }
    }),
}))

import { CHARACTER_ASSISTANT_FINAL_ROUND_NOTE, CHARACTER_ASSISTANT_MAX_LOOKUP_ROUNDS, createCharacterAssistantProject } from './characterAssistant'
import { sendCharacterAssistant } from './characterAssistantStore'

const lua = Array.from({ length: 700 }, (_, i) => `-- line ${i + 1}`).join('\n')
const source = {
    bot: {
        name: '봇',
        firstMessage: '안녕',
        triggerscript: [{ type: 'start', conditions: [], effect: [{ type: 'triggerlua', code: lua } as { type: string }] }],
    },
}

function send() {
    return sendCharacterAssistant({
        project: createCharacterAssistantProject('p', '프로젝트', 'c', '봇'),
        userText: '질문',
        source,
        chatLines: [],
        signal: new AbortController().signal,
        onText: () => {},
        onLookup: () => {},
    })
}

describe('sendCharacterAssistant', () => {
    beforeEach(() => {
        requests.length = 0
        replies.length = 0
    })

    it('keeps earlier parts of a long section when the model reads further', async () => {
        replies.push('<read ref="bot:field:lua" />', '<read ref="bot:field:lua" lines="301-600" />', '답변')
        const result = await send()
        expect(result.reply).toBe('답변')
        expect(result.pins).toEqual([{ ref: 'bot:field:lua', lines: [1, 600] }])
        expect(requests[2].formated[0].content).toContain('1| -- line 1')
        expect(requests[2].formated[0].content).toContain('600| -- line 600')
    })

    it('answers instead of failing when the model keeps asking', async () => {
        for (let i = 0; i < CHARACTER_ASSISTANT_MAX_LOOKUP_ROUNDS; i++) replies.push(`<search query="q${i}" />`)
        replies.push('지금 자료로 답한다.')
        const result = await send()
        expect(result.reply).toBe('지금 자료로 답한다.')
        expect(result.stalled).toBeFalsy()
        expect(requests).toHaveLength(CHARACTER_ASSISTANT_MAX_LOOKUP_ROUNDS + 1)
        expect(requests.at(-1)!.formated.at(-1)!.content).toContain(CHARACTER_ASSISTANT_FINAL_ROUND_NOTE)
        expect(requests[0].formated.at(-1)!.content).not.toContain(CHARACTER_ASSISTANT_FINAL_ROUND_NOTE)
    })

    it('tells the model when it asks again for material it already has', async () => {
        replies.push('<read ref="bot:field:firstMessage" />', '<read ref="bot:field:firstMessage" />', '답변')
        const result = await send()
        expect(result.reply).toBe('답변')
        expect(requests[2].formated[0].content).toContain('<already_read>')
    })
})
