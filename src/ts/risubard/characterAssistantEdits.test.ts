import { describe, expect, it, vi } from 'vitest'

vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (text: string) => text }))
vi.mock('../util', () => ({ parseToggleSyntax: () => [] }))

import type { AssistantCharacterSource } from './characterAssistant'
import { buildCharacterAssistantMessages, normalizeCharacterAssistantProject } from './characterAssistant'
import {
    applyAssistantEdit,
    formatEditResults,
    isRevertConflict,
    parseAssistantEdits,
    prepareAssistantEdits,
    readAssistantEditSlot,
    revertAssistantEdit,
    stripAssistantEdits,
} from './characterAssistantEdits'

function bot(): AssistantCharacterSource {
    return {
        name: '루리',
        desc: '루리는 보석상이다.\n말투가 차갑다.',
        firstMessage: '',
        alternateGreetings: ['안녕'],
        depth_prompt: { depth: 4, prompt: '짧게 답한다.' },
        globalLore: [
            { comment: '가게', key: '가게, 상점', content: '루리의 가게는 골목 끝에 있다.' },
            { comment: '폴더', key: 'f1', mode: 'folder' },
            { comment: '중복', key: 'x', content: 'a a' },
        ],
        customscript: [{ comment: '괄호', type: 'editdisplay', in: '\\((.+)\\)', out: '<i>$1</i>' }],
        triggerscript: [{ effect: [{ type: 'triggerlua', code: 'local hp = 10\nreturn hp' } as { type: string }] }],
    }
}

let counter = 0
const id = () => `e${++counter}`

describe('parseAssistantEdits', () => {
    it('reads find and replace and strips tags from the reply', () => {
        const text = `말투를 고칩니다.
<edit ref="bot:field:desc">
<find>
말투가 차갑다.
</find>
<replace>
말투가 다정하다.
</replace>
</edit>
<edit ref="bot:regex:1" slot="out"><replace><b>$1</b></replace></edit>`
        expect(parseAssistantEdits(text)).toEqual([
            { ref: 'bot:field:desc', find: '말투가 차갑다.', replace: '말투가 다정하다.' },
            { ref: 'bot:regex:1', slot: 'out', replace: '<b>$1</b>' },
        ])
        expect(stripAssistantEdits(text)).toBe('말투를 고칩니다.')
    })

    it('hides an edit that is still streaming', () => {
        expect(stripAssistantEdits('설명\n<edit ref="bot:field:desc">\n<find>\n말')).toBe('설명')
    })
})

describe('prepareAssistantEdits', () => {
    it('labels slots and rejects what it cannot apply', () => {
        const edits = prepareAssistantEdits(bot(), [
            { ref: 'bot:lore:1', find: '골목 끝', replace: '광장 옆' },
            { ref: 'bot:lore:3', find: 'a', replace: 'b' },
            { ref: 'bot:lore:2', replace: '본문' },
            { ref: 'ref:field:desc', replace: 'x' },
            { ref: 'bot:regex:1', replace: 'x' },
            { ref: 'bot:field:desc', find: '없는 문장', replace: 'x' },
            { ref: 'bot:field:firstMessage', replace: '어서 오세요.' },
        ], id)
        expect(edits.map((edit) => [edit.status, edit.label])).toEqual([
            ['pending', '로어북 1번 `가게` 본문'],
            ['failed', '로어북 3번 `중복` 본문'],
            ['failed', 'bot:lore:2'],
            ['failed', 'ref:field:desc'],
            ['failed', 'bot:regex:1'],
            ['failed', '`설명` 필드'],
            ['pending', '`첫 메시지` 필드'],
        ])
        expect(edits[1].error).toContain('2번')
        expect(edits[4].error).toContain('slot')
    })
})

describe('apply and revert', () => {
    it('changes only the raw slot and puts it back', () => {
        const target = bot()
        const [edit] = prepareAssistantEdits(target, [{ ref: 'bot:field:lua', find: 'hp = 10', replace: 'hp = 20' }], id)
        const applied = applyAssistantEdit(target, edit)
        expect(applied.status).toBe('applied')
        expect(readAssistantEditSlot(target, applied)).toBe('local hp = 20\nreturn hp')
        const reverted = revertAssistantEdit(target, applied)
        expect(reverted.status).toBe('reverted')
        expect(readAssistantEditSlot(target, reverted)).toBe('local hp = 10\nreturn hp')
    })

    it('edits the depth prompt without its depth header', () => {
        const target = bot()
        const [edit] = prepareAssistantEdits(target, [{ ref: 'bot:field:depthPrompt', replace: '길게 답한다.' }], id)
        applyAssistantEdit(target, edit)
        expect(target.depth_prompt).toEqual({ depth: 4, prompt: '길게 답한다.' })
    })

    it('finds a lore entry again after reordering', () => {
        const target = bot()
        const [edit] = prepareAssistantEdits(target, [{ ref: 'bot:lore:1', find: '골목 끝', replace: '광장 옆' }], id)
        target.globalLore!.unshift({ comment: '새 항목', content: '' })
        const applied = applyAssistantEdit(target, edit)
        expect(applied.status).toBe('applied')
        expect(applied.ref).toBe('bot:lore:2')
        expect(target.globalLore![1].content).toBe('루리의 가게는 광장 옆에 있다.')
    })

    it('follows a rename so revert still finds the entry', () => {
        const target = bot()
        const [edit] = prepareAssistantEdits(target, [{ ref: 'bot:lore:1', slot: 'comment', replace: '보석상' }], id)
        const applied = applyAssistantEdit(target, edit)
        expect(applied.name).toBe('보석상')
        expect(revertAssistantEdit(target, applied).status).toBe('reverted')
        expect(target.globalLore![0].comment).toBe('가게')
    })

    it('fails when the text it replaces is gone', () => {
        const target = bot()
        const [edit] = prepareAssistantEdits(target, [{ ref: 'bot:field:desc', find: '보석상', replace: '꽃집' }], id)
        target.desc = '바뀐 설명'
        const result = applyAssistantEdit(target, edit)
        expect(result.status).toBe('pending')
        expect(result.error).toContain('없습니다')
        expect(target.desc).toBe('바뀐 설명')
    })

    it('asks before reverting over a later change', () => {
        const target = bot()
        const [edit] = prepareAssistantEdits(target, [{ ref: 'bot:greeting:1', replace: '반가워' }], id)
        const applied = applyAssistantEdit(target, edit)
        target.alternateGreetings![0] = '사용자가 또 고침'
        const blocked = revertAssistantEdit(target, applied)
        expect(isRevertConflict(blocked)).toBe(true)
        expect(target.alternateGreetings![0]).toBe('사용자가 또 고침')
        expect(revertAssistantEdit(target, applied, true).status).toBe('reverted')
        expect(target.alternateGreetings![0]).toBe('안녕')
    })
})

describe('history', () => {
    it('tells the assistant what became of its edits', () => {
        const [applied, failed] = prepareAssistantEdits(bot(), [
            { ref: 'bot:field:desc', find: '차갑다', replace: '다정하다' },
            { ref: 'bot:field:desc', find: '없음', replace: 'x' },
        ], id)
        const messages = buildCharacterAssistantMessages({
            indexes: [], materials: [], lookups: [], userText: '다음',
            history: [{ id: 'a', role: 'assistant', text: '', createdAt: 0, edits: [{ ...applied, status: 'applied' }, failed] }],
        })
        expect(messages[1].content).toBe(formatEditResults([{ ...applied, status: 'applied' }, failed]))
        expect(messages[1].content).toContain('bot:field:desc: 적용됨')
        expect(messages[1].content).toContain('실패')
        expect(messages[0].content).toContain('<edit ref=')
    })

    it('keeps valid edits when loading a project', () => {
        const project = normalizeCharacterAssistantProject({
            id: 'p',
            messages: [
                { id: 'm', role: 'assistant', text: '', edits: [{ id: 'e', ref: 'bot:field:desc', slot: 'text', replace: 'x', status: 'applied', label: 'l' }, { bad: true }] },
                { id: 'n', role: 'assistant', text: 'x', edits: 'nope' },
            ],
        })
        expect(project?.messages[0].edits).toHaveLength(1)
        expect(project?.messages[1].edits).toBeUndefined()
    })
})
