import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestChatData = vi.fn()

vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (text: string) => text }))
vi.mock('../util', () => ({ parseToggleSyntax: () => [], getUserName: () => 'User' }))
vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => ({}),
    getActiveBotPresetId: () => 'p',
    getBotPresetById: () => null,
}))
vi.mock('../storage/persistentKv', () => ({
    readPersistentJson: vi.fn(),
    writePersistentJson: vi.fn(),
    removePersistentKey: vi.fn(),
}))
vi.mock('../requestLog', () => ({ fetchRequestLogs: vi.fn(), requestLogEnabled: () => false }))
vi.mock('../process/request/request', () => ({ requestChatData: (...args: unknown[]) => requestChatData(...args) }))

import { createPromptAssistantProject, fingerprintPreset, PROMPT_ASSISTANT_SELECT_PROMPT } from './promptAssistant'
import { sendPromptAssistant, type PromptAssistantStage } from './promptAssistantStore'

const block = (name: string, text: string) => ({ type: 'plain', type2: 'normal', role: 'system', name, text }) as const
const presetWith = (fourth: string) => ({
    name: 'P',
    promptTemplate: [block('A', 'alpha'), block('B', 'bravo'), block('C', 'charlie'), block('D', fourth), block('E', 'echo')] as never,
    customPromptTemplateToggle: 'x=1',
})

function send(project = createPromptAssistantProject('id', 'proj', 'p'), preset = presetWith('delta')) {
    const stages: PromptAssistantStage[] = []
    const result = sendPromptAssistant({
        project,
        model: 'model',
        userText: '질문',
        preset,
        chatLines: [],
        signal: new AbortController().signal,
        onText: () => {},
        onStage: (stage) => stages.push(stage),
    })
    return { result, stages }
}

const systemOf = (call: number) => requestChatData.mock.calls[call][0].formated[0].content as string
const lastUserOf = (call: number) => requestChatData.mock.calls[call][0].formated.at(-1).content as string

beforeEach(() => requestChatData.mockReset())

describe('sendPromptAssistant', () => {
    it('asks for blocks on the index, then answers with those bodies plus changed ones', async () => {
        requestChatData
            .mockResolvedValueOnce({ type: 'success', result: '{"all": false, "blocks": [2]}' })
            .mockResolvedValueOnce({ type: 'success', result: '답변' })
        const project = createPromptAssistantProject('id', 'proj', 'p')
        project.presetFingerprint = fingerprintPreset('p', presetWith('old delta'))
        const { result, stages } = send(project)
        const sent = await result

        expect(requestChatData).toHaveBeenCalledTimes(2)
        expect(requestChatData.mock.calls[0][0].useStreaming).toBe(false)
        expect(systemOf(0).startsWith(PROMPT_ASSISTANT_SELECT_PROMPT)).toBe(true)
        expect(systemOf(0)).toContain('<block no="4" type="plain" name="D" role="system" slot="normal" chars="5" preview="delta" omitted />')
        expect(systemOf(0)).not.toContain('bravo\n</block>')
        expect(lastUserOf(0)).toContain('내용이 바뀐 블록: 4번 `D`')

        expect(systemOf(1)).toContain('<block no="2" type="plain" name="B" role="system" slot="normal">\nbravo\n</block>')
        expect(systemOf(1)).toContain('<block no="4" type="plain" name="D" role="system" slot="normal">\ndelta\n</block>')
        expect(systemOf(1)).toContain('<block no="1" type="plain" name="A" role="system" slot="normal" chars="5" omitted />')
        expect(lastUserOf(1)).toContain('[앱 알림]')
        expect(sent).toMatchObject({ text: '답변', blocks: [2, 4] })
        expect(sent.fingerprint).toEqual(fingerprintPreset('p', presetWith('delta')))
        expect(stages).toEqual([{ step: 'select' }, { step: 'answer', blocks: [2, 4] }])
    })

    it('sends everything in one request when the project always sends the whole preset', async () => {
        requestChatData.mockResolvedValueOnce({ type: 'success', result: '답변' })
        const project = createPromptAssistantProject('id', 'proj', 'p')
        project.sendFullPreset = true
        const sent = await send(project).result
        expect(requestChatData).toHaveBeenCalledTimes(1)
        expect(systemOf(0)).not.toContain(' omitted />')
        expect(lastUserOf(0)).toBe('질문')
        expect(sent.blocks).toBe('all')
    })

    it('falls back to the whole preset when the selection cannot be read', async () => {
        requestChatData
            .mockResolvedValueOnce({ type: 'success', result: '블록 2가 필요해 보입니다.' })
            .mockResolvedValueOnce({ type: 'success', result: '답변' })
        const sent = await send().result
        expect(sent.blocks).toBe('all')
        expect(systemOf(1)).not.toContain(' omitted />')
    })

    it('stops when the selection request fails', async () => {
        requestChatData.mockResolvedValueOnce({ type: 'fail', result: '403' })
        await expect(send().result).rejects.toThrow('403')
        expect(requestChatData).toHaveBeenCalledTimes(1)
    })
})
