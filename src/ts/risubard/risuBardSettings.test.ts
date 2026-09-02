import { describe, expect, test } from 'vitest'
import {
    RISUBARD_ANALYSIS_TOKEN_LIMIT_DEFAULT,
    RISUBARD_ADDITIONAL_SEARCH_LIMIT_DEFAULT,
    RISUBARD_CANONICAL_TARGET_LIMIT_DEFAULT,
    RISUBARD_CANONICAL_WRITING_STYLE_DEFAULT,
    RISUBARD_INQUIRY_MAXIMUM_TOKEN_BUDGET_DEFAULT,
    RISUBARD_INQUIRY_EVENT_TOKEN_BUDGET_DEFAULT,
    RISUBARD_INQUIRY_SOURCE_TOKEN_BUDGET_DEFAULT,
    RISUBARD_INQUIRY_TARGET_TOKEN_BUDGET_DEFAULT,
    RISUBARD_HISTORICAL_SOURCE_MATCH_LIMIT_DEFAULT,
    buildRisuBardCanonicalWritingPolicy,
    buildRisuBardEventWritingPolicy,
    normalizeRisuBardAnalysisTokenLimit,
    normalizeRisuBardAdditionalSearchLimit,
    normalizeRisuBardCanonicalCustomStyle,
    normalizeRisuBardCanonicalTargetLimit,
    normalizeRisuBardCanonicalWritingStyle,
    normalizeRisuBardInquiryTokenBudget,
    normalizeRisuBardHistoricalSourceMatchLimit,
    resolveRisuBardChatSettings,
} from './risuBardSettings'

describe('RisuBard analysis settings', () => {
    test('defaults wiki language to Korean and resolves a chat language independently', () => {
        expect(resolveRisuBardChatSettings({}).risuBardWikiWritingLanguage).toBe('ko')
        expect(resolveRisuBardChatSettings({ risuBardWikiWritingLanguage: 'en' })
            .risuBardWikiWritingLanguage).toBe('en')
        expect(resolveRisuBardChatSettings({ risuBardWikiWritingLanguage: 'en' }, {
            risuBardWikiWritingLanguage: 'ko',
        }).risuBardWikiWritingLanguage).toBe('ko')
    })

    test.each(['standard', 'concise', 'ultra-concise', 'custom'])(
        'uses only English built-in writing instructions for %s', (style) => {
            const event = buildRisuBardEventWritingPolicy(style, 'Use short sentences.', 'en')
            const canon = buildRisuBardCanonicalWritingPolicy(style, 'Use short sentences.', 'en')
            expect(event).toContain('English')
            expect(canon).toContain('dynamic lorebook')
            expect(canon).toContain('### Current State')
            expect(canon).toContain('### Story History')
            expect(canon).toContain('recommended')
            expect(canon).toContain('3-6')
            expect(canon).toContain('entire body')
            expect(canon).toContain('existing document titles')
            expect(event + canon).not.toMatch(/[가-힣]/)
        }
    )

    test('uses conservative defaults for missing and invalid values', () => {
        expect(RISUBARD_ANALYSIS_TOKEN_LIMIT_DEFAULT).toBe(8_192)
        expect(normalizeRisuBardAnalysisTokenLimit(undefined))
            .toBe(RISUBARD_ANALYSIS_TOKEN_LIMIT_DEFAULT)
        expect(normalizeRisuBardAdditionalSearchLimit('2'))
            .toBe(RISUBARD_ADDITIONAL_SEARCH_LIMIT_DEFAULT)
        expect(normalizeRisuBardCanonicalTargetLimit(Number.NaN))
            .toBe(RISUBARD_CANONICAL_TARGET_LIMIT_DEFAULT)
    })

    test('retains minimums without imposing arbitrary setting maxima', () => {
        expect(normalizeRisuBardAnalysisTokenLimit(12)).toBe(3_072)
        expect(normalizeRisuBardAnalysisTokenLimit(99_999)).toBe(99_999)
        expect(normalizeRisuBardAdditionalSearchLimit(-3)).toBe(0)
        expect(normalizeRisuBardAdditionalSearchLimit(99)).toBe(99)
        expect(normalizeRisuBardCanonicalTargetLimit(0)).toBe(1)
        expect(normalizeRisuBardCanonicalTargetLimit(99)).toBe(99)
        expect(normalizeRisuBardAnalysisTokenLimit(Infinity)).toBe(RISUBARD_ANALYSIS_TOKEN_LIMIT_DEFAULT)
        expect(normalizeRisuBardAnalysisTokenLimit(Number.MAX_SAFE_INTEGER + 1)).toBe(RISUBARD_ANALYSIS_TOKEN_LIMIT_DEFAULT)
    })

    test('normalizes configurable inquiry map, event, source, and maximum budgets', () => {
        expect(normalizeRisuBardInquiryTokenBudget(undefined, undefined, undefined, undefined))
            .toEqual({
                target: RISUBARD_INQUIRY_TARGET_TOKEN_BUDGET_DEFAULT,
                events: RISUBARD_INQUIRY_EVENT_TOKEN_BUDGET_DEFAULT,
                perSource: RISUBARD_INQUIRY_SOURCE_TOKEN_BUDGET_DEFAULT,
                maximum: RISUBARD_INQUIRY_MAXIMUM_TOKEN_BUDGET_DEFAULT,
            })
        expect(normalizeRisuBardInquiryTokenBudget(8_000, 4_000, 9_000, 5_000))
            .toEqual({ target: 4_000, events: 4_000, perSource: 4_000, maximum: 4_000 })
        expect(normalizeRisuBardInquiryTokenBudget(1, 99_999, 1, 1))
            .toEqual({ target: 256, events: 256, perSource: 256, maximum: 99_999 })
    })

    test('normalizes the historical source candidate limit', () => {
        expect(normalizeRisuBardHistoricalSourceMatchLimit(undefined))
            .toBe(RISUBARD_HISTORICAL_SOURCE_MATCH_LIMIT_DEFAULT)
        expect(normalizeRisuBardHistoricalSourceMatchLimit(-1)).toBe(0)
        expect(normalizeRisuBardHistoricalSourceMatchLimit(99)).toBe(32)
    })

    test('keeps configured message windows above one hundred', () => {
        const settings = resolveRisuBardChatSettings({
            risuBardRecentMessageCount: 250, risuBardResponseMessageCount: 300,
        })
        expect(settings.risuBardRecentMessageCount).toBe(250)
        expect(settings.risuBardResponseMessageCount).toBe(300)
    })

    test('normalizes the shared canonical writing policy', () => {
        expect(normalizeRisuBardCanonicalWritingStyle(undefined))
            .toBe(RISUBARD_CANONICAL_WRITING_STYLE_DEFAULT)
        expect(normalizeRisuBardCanonicalWritingStyle('standard')).toBe('standard')
        expect(normalizeRisuBardCanonicalWritingStyle('ultra-concise')).toBe('ultra-concise')
        expect(normalizeRisuBardCanonicalWritingStyle('invalid')).toBe('concise')
        expect(normalizeRisuBardCanonicalCustomStyle(`  ${'가'.repeat(1_200)}  `))
            .toBe('가'.repeat(1_000))
    })

    test('builds Korean style-only instructions without weakening memory rules', () => {
        expect(buildRisuBardCanonicalWritingPolicy('concise', '')).toContain(
            '사실 하나당 한 문장'
        )
        const custom = buildRisuBardCanonicalWritingPolicy(
            'custom',
            '항목마다 짧은 명사형으로 끝낸다.'
        )
        expect(custom).toContain('한국어로 작성')
        expect(custom).toContain('항목마다 짧은 명사형으로 끝낸다.')
        expect(custom).toContain('사실 선택, 근거, 구조 및 안전 규칙을 변경하지 않는다')
        expect(custom).not.toContain('undefined')
    })

    test('keeps character canon compact while preserving detailed event evidence', () => {
        const policy = buildRisuBardCanonicalWritingPolicy('concise', '')

        expect(policy).toContain('다이나믹 로어북')
        expect(policy).toContain('권장')
        expect(policy).toContain('큰 전환점')
        expect(policy).toContain('턴별 행동 기록을 누적하지 않는다')
        expect(policy).toContain('상세 과거 행적은 사건 문서')
        expect(policy).toContain('이전 상태를 현재 사실처럼 병기하지 않는다')
        expect(policy).toContain('### 현재 상태')
        expect(policy).toContain('### 작중 행적')
        expect(policy).toContain('3~6개')
        expect(policy).toContain('[[사건 문서 제목]]')
        expect(policy).toContain('원문에 없는 행동 대상이나 장소를 보충하지 않는다')
        expect(policy).toContain('시간적 선후를 인과로 바꾸지 않는다')
        expect(policy).toContain('사건 당시 인물별 지식 경계를 유지한다')
        expect(policy).toContain('퍼즐')
        expect(policy).toContain('배치')
        expect(policy).toContain('확정 관찰과 추론')
        expect(policy).toContain('종족·생물')
        expect(policy).toContain('이름 있는 하위 장소')
        expect(policy).toContain('조사 줄기')
        expect(policy).toContain('문장이나 문단을 복사하지 않는다')
    })

    test('resolves current-chat overrides over normalized global defaults', () => {
        const resolved = resolveRisuBardChatSettings({
            risuBardModelMode: 'memory',
            risuBardRecentMessageCount: 12,
            risuBardResponseMessageCount: 20,
            showRequestStatus: true,
        }, {
            risuBardModelMode: 'model',
            risuBardRecentMessageCount: 7,
            risuBardResponseExcludeUserMessages: true,
            showRequestStatus: false,
        })

        expect(resolved.risuBardModelMode).toBe('model')
        expect(resolved.risuBardRecentMessageCount).toBe(7)
        expect(resolved.risuBardResponseMessageCount).toBe(20)
        expect(resolved.risuBardResponseExcludeUserMessages).toBe(true)
        expect(resolved.showRequestStatus).toBe(false)
    })

    test('resolves per-chat BARDCHAT context selections with token-saving defaults', () => {
        const defaults = resolveRisuBardChatSettings({})
        expect(defaults).toMatchObject({
            bardChatIncludeWiki: true,
            bardChatIncludeChat: false,
            bardChatIncludeSystemPrompt: false,
            bardChatIncludeCharacterDescription: false,
            bardChatIncludePersona: false,
            bardChatIncludeCharacterLorebook: false,
            bardChatIncludeModuleLorebook: false,
        })

        const resolved = resolveRisuBardChatSettings({
            bardChatIncludeSystemPrompt: true,
            bardChatIncludeCharacterLorebook: true,
        }, {
            bardChatIncludeSystemPrompt: false,
            bardChatIncludeChat: true,
        })
        expect(resolved).toMatchObject({
            bardChatIncludeWiki: true,
            bardChatIncludeChat: true,
            bardChatIncludeSystemPrompt: false,
            bardChatIncludeCharacterLorebook: true,
        })
    })
})
