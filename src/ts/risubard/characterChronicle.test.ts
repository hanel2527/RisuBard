import { describe, expect, it } from 'vitest'
import { buildCharacterChronicle, chroniclePage } from './characterChronicle'
import type { WikiDocument } from './wikiLink'

const doc = (id: string, overrides: Partial<WikiDocument> = {}): WikiDocument => ({
    id, title: id, type: 'event', status: 'active', relativePath: `${id}.md`,
    sourceMessageIds: [], updated: '2026-09-29', created: '2026-09-29',
    content: '### 이야기 요약\n- 기록', links: [], contextMode: 'auto', contentHash: id,
    ...overrides,
})
const alice = doc('char.alice', { type: 'character', title: '앨리스', aliases: ['여왕'] })

describe('character chronicle projection', () => {
    it('resolves stable IDs, exact aliases and explicit links without guessing mentions', () => {
        const result = buildCharacterChronicle([alice,
            doc('a', { links: ['char.alice'] }),
            doc('b', { content: '[[여왕|그녀]]가 도착했다.' }),
            doc('c', { content: '앨리스가 여왕을 만났다.' }),
            doc('d', { links: ['여왕님'] }),
        ], alice.id)
        expect(result.entries.map(e => e.id)).toEqual(['a', 'b'])
        expect(result.unlinkedCount).toBe(2)
    })
    it('reports ambiguous aliases and uses character backlinks to events', () => {
        const result = buildCharacterChronicle([
            { ...alice, links: ['옛 사건'] },
            doc('char.other', { type: 'character', title: '여왕' }),
            doc('a', { links: ['여왕'] }), doc('b', { title: '옛 사건' }),
            doc('c', { links: ['char.alice'] }),
        ], alice.id)
        expect(result.entries.map(e => e.id)).toEqual(['b', 'c'])
        expect(result.ambiguousCount).toBe(1)
    })
    it('does not silently resolve a name collision with an excluded document', () => {
        const result = buildCharacterChronicle([alice,
            doc('other', { title: '여왕', type: 'concept', contextMode: 'never' }),
            doc('a', { links: ['여왕'] }),
        ], alice.id)
        expect(result.entries).toEqual([])
        expect(result.ambiguousCount).toBe(1)
    })
    it('reflects edited and retracted events, uses recorded order and only explicit story time', () => {
        const documents = [alice,
            doc('b', { links: [alice.id], created: '2026-09-29', retrievalMetadata: { keywords: [], storyTime: { day: 1, precision: 'explicit', evidence: '다음 날' } } }),
            doc('a', { links: [alice.id], created: '2026-09-28', retrievalMetadata: { keywords: [], storyTime: { day: 0, precision: 'origin', evidence: 'first' } } }),
            doc('old', { links: [alice.id], status: 'retracted' }),
            doc('hidden', { links: [alice.id], contextMode: 'never' }),
        ]
        expect(buildCharacterChronicle(documents, alice.id).entries.map(e => [e.id, e.storyTime])).toEqual([
            ['a', undefined], ['b', '1일차: 다음 날'],
        ])
        documents[1] = { ...documents[1], content: '수정한 사건', links: [] }
        expect(buildCharacterChronicle(documents, alice.id).entries.map(e => e.id)).toEqual(['a'])
    })
    it('keeps missing sources visible but excludes known inactive and OOC source events', () => {
        const result = buildCharacterChronicle([alice,
            doc('a', { links: [alice.id], sourceMessageIds: ['valid', 'inherited:old'] }),
            doc('b', { links: [alice.id], sourceMessageIds: ['missing'] }),
            doc('c', { links: [alice.id], sourceMessageIds: ['disabled'] }),
            doc('d', { links: [alice.id], sourceMessageIds: ['ooc'] }),
        ], alice.id, [
            { role: 'char', data: 'hello', chatId: 'valid' },
            { role: 'char', data: 'hidden', chatId: 'disabled', disabled: true },
            { role: 'char', data: '<!-- OOC_turn -->', chatId: 'ooc' },
        ])
        expect(result.entries.map(e => e.id)).toEqual(['a', 'b'])
        expect(result.entries[0].source.messageIds).toEqual(['valid'])
        expect(result.entries[1].source.messageIds).toEqual([])
        expect(result.entries[1].missingSourceCount).toBe(1)
    })
    it('bounds page size and excerpts while leaving all 10,000 events accessible', () => {
        const result = buildCharacterChronicle([alice, ...Array.from({ length: 10_000 }, (_, i) =>
            doc(String(i).padStart(5, '0'), { links: [alice.id], content: '긴 한국어 기록 '.repeat(80) }))], alice.id)
        const page = chroniclePage(result.entries, 500)
        expect(page.entries).toHaveLength(20)
        expect(page.page).toBe(499)
        expect(page.entries.at(-1)?.id).toBe('09999')
        expect(page.entries.every(e => e.excerpt.length <= 361)).toBe(true)
    })
})
