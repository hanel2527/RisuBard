import { describe, expect, it, vi } from 'vitest'

vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (text: string) => text }))
vi.mock('../util', () => ({ parseToggleSyntax: () => [] }))
import {
    buildPlayerMessages,
    CHARACTER_ASSISTANT_PLAYER_PROMPT,
    clampPlayTurns,
    formatPlayLore,
    formatPlayTurnText,
    parsePlayerReply,
    PLAY_LORE_MAX_CHARS,
    PLAY_MAX_TURNS,
    type PlayerRequestInput,
} from './characterAssistantPlay'
import { captureChatContext, collectChatContext, takeChatContext, unwatchChatContext, watchChatContext } from './chatContextCapture'
import { normalizeCharacterAssistantProject } from './characterAssistant'

const material = (text: string) => text.slice(CHARACTER_ASSISTANT_PLAYER_PROMPT.length)

const base: PlayerRequestInput = {
    instruction: '1-A 반 학생들과 지하층 작전을 진행해.',
    personaName: '미도리야',
    personaPrompt: '1-A 반 학생.',
    botName: '나레이터',
    lore: [{ name: '지하층', content: '훈련장 지하 3층.' }],
    context: 'chat',
    chatLog: '<chat_log>\n<message role="assistant" name="나레이터">\n안녕\n</message>\n</chat_log>',
    wiki: [],
    lastReply: '안녕',
    turn: 2,
    total: 5,
}

describe('character assistant play', () => {
    it('clamps turns', () => {
        expect(clampPlayTurns('3')).toBe(3)
        expect(clampPlayTurns(0)).toBe(1)
        expect(clampPlayTurns('x')).toBe(1)
        expect(clampPlayTurns(999)).toBe(PLAY_MAX_TURNS)
    })

    it('builds the chat-context request with instruction, persona, lore and log', () => {
        const [system, user] = buildPlayerMessages(base)
        expect(system.role).toBe('system')
        expect(system.content).toContain('<instruction>\n1-A 반 학생들과 지하층 작전을 진행해.\n</instruction>')
        expect(system.content).toContain('<persona name="미도리야">')
        expect(system.content).toContain('<entry name="지하층">\n훈련장 지하 3층.\n</entry>')
        expect(system.content).toContain('<chat_log>')
        expect(material(system.content)).not.toContain('<last_reply')
        expect(user.content).toContain('턴 2/5')
        expect(user.content).toContain('남은 턴 3개')
    })

    it('builds the wiki-context request with wiki docs and the last reply only', () => {
        const [system] = buildPlayerMessages({ ...base, context: 'wiki', wiki: [{ name: '미도리야', content: '주인공.' }] })
        expect(system.content).toContain('<doc name="미도리야">\n주인공.\n</doc>')
        expect(system.content).toContain('<last_reply name="나레이터">\n안녕\n</last_reply>')
        expect(material(system.content)).not.toContain('<chat_log>')
    })

    it('drops lore past the length limit and says so', () => {
        const big = 'a'.repeat(PLAY_LORE_MAX_CHARS - 10)
        const text = formatPlayLore([{ name: 'A', content: big }, { name: 'B', content: 'b'.repeat(20) }])
        expect(text).toContain('name="A"')
        expect(text).not.toContain('name="B"')
        expect(text).toContain('1개 항목은 뺐다')
    })

    it('parses react and input, tolerating a cut-off closing tag', () => {
        expect(parsePlayerReply('<react>좋다</react>\n<input>"가자!"</input>')).toEqual({ reaction: '좋다', input: '"가자!"' })
        expect(parsePlayerReply('<react>좋다</react><input>가자')).toEqual({ reaction: '좋다', input: '가자' })
        expect(parsePlayerReply('그냥 글')).toEqual({ reaction: '', input: '' })
    })

    it('writes turn text with the lorebook used', () => {
        const text = formatPlayTurnText({ turn: 1, total: 5, reaction: '좋다', input: '가자', lorebook: ['지하층'], outcome: 'done' })
        expect(text).toBe('[플레이 테스트 턴 1/5]\n관찰: 좋다\n입력: 가자\n봇 응답에 들어간 로어북: 지하층')
        expect(formatPlayTurnText({ turn: 2, total: 5, reaction: '', input: '', lorebook: [], outcome: 'failed', note: '실패함' }))
            .toBe('[플레이 테스트 턴 2/5 (실패)]\n봇 응답에 들어간 로어북: 없음\n실패함')
    })

    it('keeps valid play fields when loading a project and drops broken ones', () => {
        const project = normalizeCharacterAssistantProject({
            id: 'p',
            messages: [
                { id: 'a', role: 'user', text: 's', playStart: { turns: 5, mode: 'semi', context: 'wiki', chatName: 'c' } },
                { id: 'b', role: 'assistant', text: 't', play: { turn: 1, total: 5, reaction: '', input: 'x', outcome: 'done', lorebook: ['L'] } },
                { id: 'c', role: 'assistant', text: 't', play: { turn: 1, total: 5, outcome: 'weird' }, playStart: { turns: 'x' } },
            ],
        })!
        expect(project.messages[0].playStart?.mode).toBe('semi')
        expect(project.messages[1].play?.lorebook).toEqual(['L'])
        expect(project.messages[2].play).toBeUndefined()
        expect(project.messages[2].playStart).toBeUndefined()
    })
})

describe('chat context capture', () => {
    const messages = [
        { requestStatusSources: [{ kind: 'lorebook' as const, name: '지하층', role: 'system' as const, content: 'x' }] },
        { requestStatusSources: [
            { kind: 'grimoire' as const, name: '올마이트', role: 'system' as const, content: 'y' },
            { kind: 'lorebook' as const, name: '지하층', role: 'system' as const, content: 'x' },
            { kind: 'wiki' as const, name: '문서', role: 'system' as const, content: '위키 본문' },
            { kind: 'chatHistory' as const, role: 'user' as const, content: 'z' },
        ] },
        {},
    ]

    it('collects lorebook names once and wiki text', () => {
        expect(collectChatContext(messages)).toEqual({ lorebook: ['지하층', '올마이트'], wiki: [{ name: '문서', content: '위키 본문' }] })
    })

    it('only captures watched chats and forgets after a take', () => {
        captureChatContext('other', messages)
        expect(takeChatContext('other')).toBeUndefined()
        watchChatContext('test')
        captureChatContext('test', messages)
        expect(takeChatContext('test')?.lorebook).toEqual(['지하층', '올마이트'])
        expect(takeChatContext('test')).toBeUndefined()
        unwatchChatContext('test')
        captureChatContext('test', messages)
        expect(takeChatContext('test')).toBeUndefined()
    })
})
