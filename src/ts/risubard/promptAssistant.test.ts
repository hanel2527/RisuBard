import { describe, expect, it, vi } from 'vitest'

vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (text: string) => text }))
vi.mock('../util', () => ({ parseToggleSyntax: () => [] }))

import {
    buildPromptAssistantMessages,
    clampChatMessageCount,
    compactRequestBody,
    formatChatLogForAssistant,
    markStrongForCjk,
    normalizePromptAssistantProject,
    serializePresetForAssistant,
    PROMPT_ASSISTANT_SYSTEM_PROMPT,
    STRONG_CLOSE_MARK,
    STRONG_OPEN_MARK,
    stripBlockWrapper,
    restoreEscapedLineBreaks,
    collectBlockNames,
    findBlockReferences,
    resolveBlockIndex,
    forkPromptAssistantMessages,
    formatPromptAssistantMarkdown,
    promptAssistantExportFileName,
    normalizePromptAssistantIndex,
    fingerprintPreset,
    diffPresetFingerprint,
    blocksToReread,
    formatPresetChangeNotice,
    parseBlockSelection,
    resolveSentBlocks,
    describeAttachment,
    buildPromptAssistantSelectionMessages,
} from './promptAssistant'

describe('serializePresetForAssistant', () => {
    it('numbers blocks in editor order and decodes V2 activation', () => {
        const text = serializePresetForAssistant({
            name: 'Main "RP"',
            promptTemplate: [
                { type: 'plain', type2: 'main', role: 'system', name: '규칙', text: '{{#when::keep::{{equal::{{getglobalvar::toggle_short}}::1}}}}\n짧게 써라.\n{{/when}}' },
                { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
                { type: 'description', innerFormat: '<desc>{{slot}}</desc>' },
            ],
            customPromptTemplateToggle: 'short=짧은 응답',
        })
        expect(text).toContain('<preset name="Main &quot;RP&quot;">')
        expect(text).toContain('<block no="1" type="plain" name="규칙" role="system" slot="main" active_when="toggle_short == 1">\n짧게 써라.\n</block>')
        expect(text).toContain('<block no="2" type="chat" range_start="0" range_end="end" />')
        expect(text).toContain('<block no="3" type="description">\n<desc>{{slot}}</desc>\n</block>')
        expect(text).toContain('<toggles>\nshort=짧은 응답\n</toggles>')
    })

    it('falls back to legacy prompt fields without a template', () => {
        const text = serializePresetForAssistant({ promptTemplate: null, mainPrompt: 'main', jailbreak: 'jb', globalNote: 'note' })
        expect(text).toContain('<legacy_main_prompt>\nmain\n</legacy_main_prompt>')
        expect(text).toContain('<toggles />')
    })
})

describe('compactRequestBody', () => {
    it('keeps only role-tagged text from OpenAI-style bodies', () => {
        const body = JSON.stringify({
            model: 'x', temperature: 1,
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:...' } }] },
            ],
        })
        expect(compactRequestBody(body)).toBe('<turn role="system">\nsys\n</turn>\n<turn role="user">\nhi\n[image_url]\n</turn>')
    })

    it('reads Anthropic system and Gemini contents', () => {
        expect(compactRequestBody(JSON.stringify({ system: [{ type: 'text', text: 'S' }], messages: [{ role: 'user', content: 'U' }] })))
            .toBe('<turn role="system">\nS\n</turn>\n<turn role="user">\nU\n</turn>')
        expect(compactRequestBody(JSON.stringify({ systemInstruction: { parts: [{ text: 'S' }] }, contents: [{ role: 'model', parts: [{ text: 'M' }] }] })))
            .toBe('<turn role="system">\nS\n</turn>\n<turn role="model">\nM\n</turn>')
    })

    it('returns unknown shapes unchanged', () => {
        expect(compactRequestBody('not json')).toBe('not json')
        expect(compactRequestBody('{"prompt":"p"}')).toBe('{"prompt":"p"}')
    })
})

describe('buildPromptAssistantMessages', () => {
    it('puts materials in the system message and skips failed turns', () => {
        const messages = buildPromptAssistantMessages({
            preset: '<preset />',
            chatLog: formatChatLogForAssistant([{ role: 'char', name: 'Alice', text: 'hello' }]),
            sentRequest: 'REQ',
            history: [
                { id: '1', role: 'user', text: 'q1', createdAt: 0 },
                { id: '2', role: 'assistant', text: 'error', createdAt: 0, failed: true },
            ],
            userText: 'q2',
        })
        expect(messages[0].role).toBe('system')
        expect(messages[0].content.startsWith(PROMPT_ASSISTANT_SYSTEM_PROMPT)).toBe(true)
        expect(messages[0].content).toContain('<message role="assistant" name="Alice">\nhello\n</message>')
        expect(messages[0].content).toContain('<sent_request>\nREQ\n</sent_request>')
        expect(messages.slice(1)).toEqual([
            { role: 'user', content: 'q1' },
            { role: 'user', content: 'q2' },
        ])
    })

    it('omits empty materials', () => {
        const [system] = buildPromptAssistantMessages({ preset: '<preset />', chatLog: '', history: [], userText: 'q' })
        expect(system.content).toBe(`${PROMPT_ASSISTANT_SYSTEM_PROMPT}

<preset />`)
    })
})

describe('markStrongForCjk', () => {
    const open = STRONG_OPEN_MARK
    const close = STRONG_CLOSE_MARK
    it('marks bold followed by Korean particles, including code inside', () => {
        expect(markStrongForCjk('**3번 블록 `서술 규칙`**이 원인'))
            .toBe(`${open}3번 블록 \`서술 규칙\`${close}이 원인`)
    })

    it('leaves code, spaced delimiters and unclosed pairs alone', () => {
        expect(markStrongForCjk('`**a**` ```\n**b**\n``` ** c ** **d'))
            .toBe('`**a**` ```\n**b**\n``` ** c ** **d')
    })
})

describe('restoreEscapedLineBreaks', () => {
    it('turns an escaped one-line suggestion back into lines', () => {
        // Model output: one line with literal backslash escapes, plus the fence's own newline.
        expect(restoreEscapedLineBreaks('{{#if 1}}\\n\\n- Write \\"natural\\" Korean.\\n\\t- tab\\n{{/if}}\n'))
            .toBe('{{#if 1}}\n\n- Write "natural" Korean.\n\t- tab\n{{/if}}\n')
    })

    it('turns a stray \\n at the end of real lines into the blank line it meant', () => {
        // Shape seen in a real reply: every line ends with a literal backslash-n before the real break.
        expect(restoreEscapedLineBreaks('{{#if_pure 1}}\\n\n{{#if_pure 2}}\\n\n### 제목\n- 본문\\n\n{{/if}}\n{{/if}}\n'))
            .toBe('{{#if_pure 1}}\n\n{{#if_pure 2}}\n\n### 제목\n- 본문\n\n{{/if}}\n{{/if}}\n')
    })

    it('leaves real multi-line bodies that mention a literal backslash-n alone', () => {
        const body = 'line one\nuse \\n to split\nline three\n'
        expect(restoreEscapedLineBreaks(body)).toBe(body)
        expect(restoreEscapedLineBreaks('single \\n mention')).toBe('single \\n mention')
    })
})

describe('stripBlockWrapper', () => {
    it('removes the material-only block tags around a suggestion', () => {
        expect(stripBlockWrapper('<block no="114" type="plain" name="대화문 — 켜짐" role="user">\n{{#if_pure 1}}\n본문\n{{/if}}\n</block>\n'))
            .toBe('{{#if_pure 1}}\n본문\n{{/if}}')
    })

    it('keeps text without a wrapper unchanged', () => {
        expect(stripBlockWrapper('본문\n<block>는 본문 속 단어')).toBe('본문\n<block>는 본문 속 단어')
    })
})

describe('block references', () => {
    it('finds numbers in prose and in block tags', () => {
        expect(findBlockReferences('114번 블록 `대화`와 블록 7번, 블록 #3, 그리고 <block no="20" type="plain">'))
            .toEqual([3, 7, 20, 114])
        expect(findBlockReferences('1140개의 블록이 아님, 2024년')).toEqual([])
        expect(findBlockReferences('11번째 블록, #12 블록, 블록 no.13, 블록 번호 14, 블록 #15번째, 16 블록'))
            .toEqual([11, 12, 13, 14, 15, 16])
        expect(findBlockReferences('버전 1.5 블록')).toEqual([])
    })

    it('records names for mentioned blocks only', () => {
        const preset = { promptTemplate: [
            { type: 'plain', type2: 'normal', role: 'system', text: '', name: 'A' },
            { type: 'plain', type2: 'normal', role: 'system', text: '' },
        ] } as Parameters<typeof collectBlockNames>[0]
        expect(collectBlockNames(preset, '2번 블록과 1번 블록, 9번 블록')).toEqual({ 1: 'A', 2: '' })
        expect(collectBlockNames(preset, '블록 언급 없음')).toBeUndefined()
    })

    it('follows a renamed number back to the named block', () => {
        const items = [{ name: 'X' }, { name: 'B' }, { name: 'A' }, { name: 'B' }]
        expect(resolveBlockIndex(items, 3, 'A')).toBe(2)
        expect(resolveBlockIndex(items, 1, 'A')).toBe(2)
        expect(resolveBlockIndex(items, 3, 'B')).toBe(1)
        expect(resolveBlockIndex(items, 2, 'gone')).toBe(-1)
        expect(resolveBlockIndex(items, 4)).toBe(3)
        expect(resolveBlockIndex(items, 9)).toBe(-1)
    })
})

describe('project normalization', () => {
    it('clamps chat counts and repairs stored projects', () => {
        expect(clampChatMessageCount(-3)).toBe(0)
        expect(clampChatMessageCount('7.9')).toBe(7)
        expect(clampChatMessageCount(10_000)).toBe(200)
        const project = normalizePromptAssistantProject({ id: 'p', name: ' ', model: 'weird', chatMessages: 'x', messages: [{ id: 'm', role: 'system', text: 'x' }] })
        expect(project).toMatchObject({ name: '새 프로젝트', model: 'model', chatMessages: 0, messages: [] })
        expect(normalizePromptAssistantProject({ name: 'no id' })).toBeNull()
    })
})

describe('forkPromptAssistantMessages', () => {
    const messages = [
        { id: 'u1', role: 'user' as const, text: 'q1', createdAt: 0 },
        { id: 'a1', role: 'assistant' as const, text: 'r1', createdAt: 0, blockNames: { 2: 'B' } },
        { id: 'u2', role: 'user' as const, text: 'q2', createdAt: 0 },
        { id: 'a2', role: 'assistant' as const, text: 'r2', createdAt: 0 },
    ]

    it('keeps a reply and everything before it', () => {
        const fork = forkPromptAssistantMessages(messages, 'a1')!
        expect(fork.messages.map((message) => message.id)).toEqual(['u1', 'a1'])
        expect(fork.draft).toBe('')
        fork.messages[1].blockNames![2] = 'changed'
        expect(messages[1].blockNames![2]).toBe('B')
    })

    it('stops before a question and returns it as a draft', () => {
        const fork = forkPromptAssistantMessages(messages, 'u2')!
        expect(fork.messages.map((message) => message.id)).toEqual(['u1', 'a1'])
        expect(fork.draft).toBe('q2')
        expect(forkPromptAssistantMessages(messages, 'missing')).toBeNull()
    })
})

describe('formatPromptAssistantMarkdown', () => {
    it('writes a header and separates every message with a rule', () => {
        const project = normalizePromptAssistantProject({
            id: 'p', name: '대사 버전', messages: [
                { id: 'u', role: 'user', text: '질문\n', createdAt: 0, attached: { chatMessages: 3, request: true } },
                { id: 'a', role: 'assistant', text: '**답변**', createdAt: 0 },
                { id: 'f', role: 'assistant', text: 'error', createdAt: 0, failed: true },
            ],
        })!
        const date = new Date(2026, 9, 11, 9, 5)
        expect(formatPromptAssistantMarkdown(project, 'Default', date)).toBe([
            '# 대사 버전',
            '- 프리셋: Default\n- 저장: 2026-10-11 09:05\n- 메시지: 3개',
            '---\n\n## 나\n\n_첨부: 최근 챗 3개, 실제 요청_\n\n질문',
            '---\n\n## 비서\n\n**답변**',
            '---\n\n## 비서 (응답 실패)\n\nerror',
        ].join('\n\n') + '\n')
        expect(promptAssistantExportFileName('a/b:c', date)).toBe('프롬프트 비서 - a b c - 2026-10-11_0905.md')
    })

    it('defaults the model to main', () => {
        expect(normalizePromptAssistantIndex({}).model).toBe('model')
        expect(normalizePromptAssistantIndex({ model: 'otherAx' }).model).toBe('otherAx')
    })
})

describe('preset fingerprint and change notice', () => {
    const block = (name: string, text: string) => ({ type: 'plain', type2: 'normal', role: 'system', name, text }) as const
    const preset = (items: ReturnType<typeof block>[], toggles = 't=1') => ({ promptTemplate: [...items], customPromptTemplateToggle: toggles })

    it('reports nothing for an identical preset or a different preset id', () => {
        const before = fingerprintPreset('p', preset([block('A', 'a'), block('B', 'b')]))
        expect(diffPresetFingerprint(before, fingerprintPreset('p', preset([block('A', 'a'), block('B', 'b')])))).toBeNull()
        expect(diffPresetFingerprint(before, fingerprintPreset('q', preset([block('A', 'x')])))).toBeNull()
        expect(diffPresetFingerprint(undefined, before)).toBeNull()
    })

    it('finds edited, added and removed blocks by name, with current numbers', () => {
        const before = fingerprintPreset('p', preset([block('A', 'a'), block('B', 'b'), block('C', 'c'), block('D', 'd')]))
        const after = fingerprintPreset('p', preset([block('A', 'a'), block('C', 'c2'), block('D', 'd'), block('E', 'e')], 't=2'))
        expect(diffPresetFingerprint(before, after)).toEqual({
            changed: [{ no: 2, name: 'C' }],
            added: [{ no: 4, name: 'E' }],
            removed: [{ name: 'B' }],
            reordered: false,
            togglesChanged: true,
        })
    })

    it('treats a moved block as reordered, not changed', () => {
        const before = fingerprintPreset('p', preset([block('A', 'a'), block('B', 'b')]))
        const change = diffPresetFingerprint(before, fingerprintPreset('p', preset([block('B', 'b'), block('A', 'a')])))!
        expect(change.changed).toEqual([])
        expect(change.reordered).toBe(true)
        expect(blocksToReread(change)).toEqual([])
    })

    it('writes a notice that names blocks and limits rereading to them', () => {
        const notice = formatPresetChangeNotice({ changed: [{ no: 146, name: '이야기 목표 08' }], added: [], removed: [{ name: 'bitter' }], reordered: false, togglesChanged: true })
        expect(notice).toContain('[앱 알림]')
        expect(notice).toContain('내용이 바뀐 블록: 146번 `이야기 목표 08`')
        expect(notice).toContain('삭제된 블록: `bitter`')
        expect(notice).toContain('블록 번호가 이전 답변과 달라졌을 수 있습니다')
        expect(notice).toContain('사이드바 토글 정의')
        expect(notice).toContain('바뀌지 않은 블록에 대한 이전 분석은 그대로 써도 됩니다')
    })
})

describe('block index and selection', () => {
    const items = [
        { type: 'plain', type2: 'normal', role: 'system', name: 'A', text: '{{#when::keep::{{greater::{{getglobalvar::toggle_x}}::1}}}}\nfirst line\nsecond\n{{/when}}' },
        { type: 'plain', type2: 'normal', role: 'user', name: 'B', text: 'body b' },
        { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
    ] as const

    it('sends chosen bodies and one-line entries for the rest', () => {
        const text = serializePresetForAssistant({ promptTemplate: [...items] as never }, { include: new Set([2]), preview: true })
        expect(text).toContain('<block no="1" type="plain" name="A" role="system" slot="normal" active_when="toggle_x > 1" chars="17" preview="first line" omitted />')
        expect(text).toContain('<block no="2" type="plain" name="B" role="user" slot="normal">\nbody b\n</block>')
        expect(text).toContain('<block no="3" type="chat" range_start="0" range_end="end" />')
        expect(text).not.toContain('second')
    })

    it('parses the selection reply defensively', () => {
        expect(parseBlockSelection('```json\n{"all": false, "blocks": [3, "2", 99, 2]}\n```', 10)).toEqual({ all: false, blocks: [2, 3] })
        expect(parseBlockSelection('{"all": true}', 10)).toEqual({ all: true, blocks: [] })
        expect(parseBlockSelection('블록 3이 필요합니다', 10)).toBeNull()
        expect(parseBlockSelection('{"note": 1}', 10)).toBeNull()
    })

    it('adds changed blocks and falls back to the whole preset when needed', () => {
        expect(resolveSentBlocks({ all: false, blocks: [5] }, [9, 200], 100)).toEqual([5, 9])
        expect(resolveSentBlocks(null, [], 100)).toBe('all')
        expect(resolveSentBlocks({ all: true, blocks: [] }, [], 100)).toBe('all')
        expect(resolveSentBlocks({ all: false, blocks: Array.from({ length: 60 }, (_, i) => i + 1) }, [], 100)).toBe('all')
        expect(describeAttachment({ chatMessages: 3, request: true, blocks: [1, 2] })).toBe('프리셋 블록 2개, 최근 챗 3개, 실제 요청')
        expect(describeAttachment({ chatMessages: 0, request: false, blocks: 'all' })).toBe('프리셋 전체')
    })

    it('puts the notice in front of the question in both steps', () => {
        const base = { preset: '<preset />', history: [], userText: 'q', notice: '[앱 알림] x' }
        expect(buildPromptAssistantSelectionMessages(base).at(-1)).toEqual({ role: 'user', content: '[앱 알림] x\n\nq' })
        expect(buildPromptAssistantMessages(base).at(-1)).toEqual({ role: 'user', content: '[앱 알림] x\n\nq' })
    })
})
