import { describe, expect, test } from 'vitest'
import { createWikiPackage, parseWikiPackage, serializeWikiPackage, validateImportConflicts } from './wikiTransferPackage'

const alice = { id: 'character.alice', type: 'character', title: '앨리스', aliases: ['Alice'], content: '## 앨리스\n\n[[숲]]에 산다.', contextMode: 'auto', status: 'active', sourceMessageIds: ['private-message'], relativePath: 'characters/alice.md', retrievalMetadata: { keywords: ['마녀'] } } as const

describe('portable wiki package', () => {
    test('round trips selected content, aliases, links and retrieval without live sources or paths', () => {
        const pack = createWikiPackage([alice], [alice.id])
        const text = serializeWikiPackage(pack)
        expect(parseWikiPackage(text).documents[0]).toMatchObject({ title: '앨리스', aliases: ['Alice'], content: alice.content, retrievalMetadata: { keywords: ['마녀'] } })
        expect(text).not.toContain('private-message')
        expect(text).not.toContain('characters/alice.md')
    })
    test.each([
        { type: 'event', title: '사건' },
        { type: 'other', title: '스토리 아크 플롯' },
        { type: 'other', title: 'Story Arc Map' },
        { type: 'other', title: '이름 변경', content: '## 이름 변경\n<!-- risubard-story-arc-checkpoint: event.1 -->' },
    ])('rejects reserved documents both on export and import: $title', (reserved) => {
        const doc = { ...alice, ...reserved }
        expect(() => createWikiPackage([doc], [doc.id])).toThrow()
        const pack = createWikiPackage([alice], [alice.id])
        expect(() => parseWikiPackage(JSON.stringify({ ...pack, documents: [{ ...pack.documents[0], ...reserved }] }))).toThrow()
    })
    test('rejects unknown fields, malformed content and empty selection', () => {
        expect(() => createWikiPackage([alice], [])).toThrow()
        const pack = createWikiPackage([alice], [alice.id])
        expect(() => parseWikiPackage(JSON.stringify({ ...pack, documents: [{ ...pack.documents[0], relativePath: '../escape.md' }] }))).toThrow()
        expect(() => parseWikiPackage(JSON.stringify({ ...pack, documents: [{ ...pack.documents[0], content: '' }] }))).toThrow()
    })
    test('refuses conflicting identities and a second current scene before any writes', () => {
        const pack = createWikiPackage([alice], [alice.id])
        expect(() => validateImportConflicts(pack, [{ id: 'different', type: 'character', title: 'Alice', aliases: [], status: 'active' }])).toThrow('Alice')
        const scene = { ...alice, id: 'scene', type: 'scene', title: '장면', contextMode: 'always' }
        expect(() => validateImportConflicts(createWikiPackage([scene], ['scene']), [{ id: 'old', type: 'scene', title: '다른 장면', aliases: [], status: 'active' }])).toThrow()
        expect(() => validateImportConflicts(pack, [])).not.toThrow()
    })
})
