import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { describe, expect, test } from 'vitest'
import { countActiveMemoryTurns, resolveDynamicMemoryBudget } from '../../src/ts/risubard/dynamicMemoryBudget'
import { resolveRisuBardChatSettings } from '../../src/ts/risubard/risuBardSettings'
import { inquireMarkdownDocuments } from './risubard-markdown-inquiry'
import type { MarkdownWikiDocument } from './risubard-markdown-wiki'

const answer = '서윤은 청동 등대 지하 세 번째 서랍에 쪽빛 유리구슬을 숨겼다.'
const paraphrase = 'Which keepsake did she leave beneath the beacon?'
const settings = resolveRisuBardChatSettings({
    risuBardDynamicMemoryMode: 'balanced',
    risuBardDynamicMemoryMaximumTokens: 2048,
    risuBardInquiryTargetTokenBudget: 512,
    risuBardInquiryEventTokenBudget: 512,
    risuBardInquirySourceTokenBudget: 256,
    risuBardInquiryMaximumTokenBudget: 1024,
})

function document(index: number, title: string, content: string): MarkdownWikiDocument {
    return {
        id: `scale-event-${index}`, type: 'event', title,
        relativePath: `events/scale-${index}.md`, content,
        contentHash: createHash('sha256').update(content).digest('hex'),
        status: 'active', contextMode: 'auto', aliases: [], links: [],
        sourceMessageIds: [`scale-turn-${index}`], updated: '2026-09-29T00:00:00.000Z',
    }
}

function fixture(size: number) {
    const people = ['민아', '진우', '혜린', '도겸', '가온']
    const places = ['서쪽 시장', '돌다리', '남문 여관', '산길', '도서관', '방앗간', '강변 부두']
    const objects = ['식량 장부', '낡은 지도', '연주 악보', '여행 허가증', '마른 꽃', '장화', '여관 열쇠', '여비']
    const actions = ['맡겼다', '돌려주었다', '발견했다', '분실했다', '수선했다', '사들였다']
    const documents = Array.from({ length: size }, (_, index) => {
        const person = people[index % people.length]
        const place = places[Math.floor(index / people.length) % places.length]
        const object = objects[Math.floor(index / 7) % objects.length]
        const action = actions[Math.floor(index / 13) % actions.length]
        return document(index, `${index + 1}일 ${place}의 기록`, [
            `## ${index + 1}일 현장 기록`,
            `${person}는 ${place}에서 ${object}을 ${action}. 인수 기록은 ${index + 100}번이다.`,
            `일행은 다음 일정으로 ${places[(index + 3) % places.length]}을 정했다. ${people[(index + 2) % people.length]}는 이 결정을 아직 듣지 못했다.`,
            index % 3 === 0 ? `지난 약속의 확인일은 ${index + 2}일이다. 당사자는 ${person}이며 다른 사람에게 의무가 넘어가지 않았다.` : `목격자가 확인한 시각은 ${index % 24}시이며 전달자의 추측은 기록에 포함하지 않았다.`,
            `${people[(index + 1) % people.length]}가 별도로 보관한 ${objects[(index + 4) % objects.length]}은 이번 거래의 대상이 아니다. ${person}가 떠난 뒤 ${places[(index + 5) % places.length]}에서 접수한 문의는 ${index + 200}번 기록으로 넘겼다.`,
        ].join('\n\n'))
    })
    // One old document exceeds the former editor limit. Vary paragraphs by recorded
    // participant, location, object and sequence rather than repeating filler text.
    const longArchive = documents.slice(1, 100).map(doc => doc.content).join('\n\n')
    const content = `## 청동 등대 약속\n\n### 동행 중 확인한 다른 기록\n\n${longArchive}\n\n### 서윤이 숨긴 물건\n\n${answer}`
    documents[0] = document(0, '서윤의 청동 등대 약속', content)
    const turns = Array.from({ length: size }, (_, index) => ({ role: 'char', chatId: `scale-turn-${index}` }))
    return { documents, turns, target: documents[0] }
}

describe('bounded long-chat evidence regression (synthetic, no provider accuracy claim)', () => {
    test.each([100, 1000, 5000, 10000])('retains final evidence and bounded input across %i active turns/documents', size => {
        const { documents, turns, target } = fixture(size)
        expect(target.content.length).toBeGreaterThan(18961)
        const budget = resolveDynamicMemoryBudget(settings, countActiveMemoryTurns(turns))
        const shared = {
            documents,
            tokenBudget: { target: budget.target, events: budget.events, perSource: budget.perSource, maximum: budget.maximum },
            retrievalLimits: { candidates: budget.candidateLimit, directSeeds: budget.directSeedLimit },
        }
        // This is a deterministic provider fixture supplying an exact verified span.
        // It tests selection/packing after retrieval, not embedding recall or answer accuracy.
        const semanticMatch = { documentId: target.id, score: 0.91, contentHash: target.contentHash,
            start: target.content.indexOf(answer), end: target.content.indexOf(answer) + answer.length }
        const scenarios = [
            { name: 'explicit-keywords', currentInput: '청동 등대 약속에서 서윤이 숨긴 물건은 무엇인가?' },
            { name: 'paraphrase-provider-fixture', currentInput: paraphrase, semanticMatches: [semanticMatch] },
        ]
        for (const scenario of scenarios) {
            const started = performance.now()
            const result = inquireMarkdownDocuments({ ...shared, ...scenario })
            const elapsedMs = Number((performance.now() - started).toFixed(2))
            expect(result.sources.map(source => source.content).join('\n')).toContain(answer)
            expect(result.evidenceRequests).toContainEqual(expect.objectContaining({ messageId: 'scale-turn-0', eventTitle: target.title }))
            if (scenario.semanticMatches) expect(result.evidenceRequests[0].documentId).toBe(target.id)
            expect(result.metrics.candidateCount).toBeLessThanOrEqual(budget.candidateLimit)
            expect(result.sources.length).toBeLessThanOrEqual(12)
            expect(result.metrics.selectedTokens).toBeLessThanOrEqual(budget.maximum)
            expect(result.sources.reduce((sum, source) => sum + source.tokens, 0)).toBeLessThanOrEqual(budget.maximum)
            for (const source of result.sources) expect(source.tokens).toBeLessThanOrEqual(budget.perSource)
            console.info(JSON.stringify({ fixture: 'synthetic-provider-fixture', size, query: scenario.name, elapsedMs,
                tokenMaximum: budget.maximum, ...result.metrics }))
        }
        const stale = inquireMarkdownDocuments({ ...shared, currentInput: paraphrase,
            semanticMatches: [{ ...semanticMatch, contentHash: 'outdated-source-hash' }] })
        expect(stale.metrics.semanticCandidateCount).toBe(0)
        expect(stale.sources).toEqual([])
        expect(stale.evidenceRequests).toEqual([])
    })
})
