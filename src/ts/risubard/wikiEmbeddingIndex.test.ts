import { describe, expect, it, vi } from 'vitest'
import { WikiEmbeddingIndex, buildWikiEmbeddingQueries, mergeWikiSemanticMatches } from './wikiEmbeddingIndex'

const chunk = (documentId: string, text: string, contentHash = 'hash') => ({
    documentId, text, contentHash, start: 0, end: text.length,
})
const page = (chunks = [chunk('betrayal', '비밀을 적에게 넘겼다.')]) =>
    async () => ({ revision: 'r1', chunks, nextOffset: null })
const cache = () => {
    const values = new Map<string, number[]>()
    return { read: async (key: string) => values.get(key), write: async (key: string, value: number[]) => { values.set(key, value) } }
}

describe('optional wiki embedding index', () => {
    it('finds a paraphrased event without a shared keyword and returns its verified range', async () => {
        const embed = vi.fn(async (texts: string[], purpose: string) => texts.map(() => purpose === 'query' ? [0.98, 0.02] : [1, 0]))
        const index = new WikiEmbeddingIndex({ identity: 'local', embed }, cache())
        await index.refresh(page())
        const result = await index.search('배신당한 일', '')
        expect(result.matches[0]).toMatchObject({ documentId: 'betrayal', contentHash: 'hash', start: 0, end: 12 })
        expect(result.evidenceQuery).toContain('비밀을 적에게 넘겼다.')
    })

    it('uses recent context to distinguish two promises behind an implicit reference', async () => {
        const embed = async (texts: string[], purpose: string) => texts.map(text => purpose === 'document'
            ? text.includes('다리') ? [1, 0] : [0, 1]
            : text.includes('다리') ? [1, 0] : [0.7, 0.7])
        const index = new WikiEmbeddingIndex({ identity: 'local', embed }, cache())
        await index.refresh(page([chunk('bridge', '다리에서 재회하기로 맹세했다.'), chunk('shop', '상점에서 빚을 갚기로 했다.')]))
        expect((await index.search('그때 약속 기억해?', '우리는 무너진 다리에 도착했다.')).matches.map(x => x.documentId)).toEqual(['bridge'])
    })

    it('reuses unchanged vectors, embeds edits, and drops deleted documents', async () => {
        const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
        const index = new WikiEmbeddingIndex({ identity: 'model-a', embed }, cache())
        await index.refresh(page([chunk('a', 'first'), chunk('b', 'second')]))
        await index.refresh(page([chunk('a', 'first')]))
        expect(embed).toHaveBeenCalledTimes(1)
        await index.refresh(page([chunk('a', 'edited', 'hash2')]))
        expect(embed).toHaveBeenCalledTimes(2)
        expect((await index.search('query', '')).matches).toEqual([expect.objectContaining({ documentId: 'a', contentHash: 'hash2' })])
    })

    it('never mixes vector spaces across provider identities', async () => {
        const storage = cache()
        const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
        await new WikiEmbeddingIndex({ identity: 'model-a', embed }, storage).refresh(page())
        await new WikiEmbeddingIndex({ identity: 'model-b', embed }, storage).refresh(page())
        expect(embed).toHaveBeenCalledTimes(2)
    })

    it('reuses live document vectors when the disposable disk cache is unavailable', async () => {
        const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
        const index = new WikiEmbeddingIndex({ identity: 'model-a', embed }, {
            read: async () => undefined,
            write: async () => { throw new Error('disk unavailable') },
        })
        await index.refresh(page([chunk('a', 'unchanged'), chunk('b', 'old')]))
        await index.refresh(page([chunk('a', 'unchanged', 'new-document-hash'), chunk('b', 'edited')]))
        expect(embed.mock.calls.map(([texts]) => texts)).toEqual([['unchanged', 'old'], ['edited']])
        await index.refresh(page([chunk('a', 'unchanged', 'new-document-hash')]))
        expect(embed).toHaveBeenCalledTimes(2)
        expect((await index.search('query', '')).matches).toEqual([
            expect.objectContaining({ documentId: 'a', contentHash: 'new-document-hash' }),
        ])
    })

    it('returns empty while unprepared and on provider failure or timeout', async () => {
        const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
        const index = new WikiEmbeddingIndex({ identity: 'local', embed }, cache())
        expect((await index.search('query', '')).matches).toEqual([])
        expect(embed).not.toHaveBeenCalled()
        await index.refresh(page())
        embed.mockRejectedValueOnce(new Error('offline'))
        expect((await index.search('query', '')).matches).toEqual([])
        embed.mockImplementationOnce(() => new Promise(() => {}))
        expect((await index.search('query', '', 5)).matches).toEqual([])
    })

    it('rejects malformed vector batches and never publishes a partial revision', async () => {
        const index = new WikiEmbeddingIndex({ identity: 'local', embed: async () => [[NaN]] }, cache())
        await expect(index.refresh(page())).rejects.toThrow()
        expect(index.ready).toBe(false)
    })

    it('aborts obsolete background work before publishing', async () => {
        const index = new WikiEmbeddingIndex({ identity: 'local', embed: async texts => texts.map(() => [1, 0]) }, cache())
        await index.refresh(page(), () => false)
        expect(index.ready).toBe(false)
    })

    it('bounds contextual queries and retains the current request', () => {
        const queries = buildWikiEmbeddingQueries('지금 질문', '오래된 문맥'.repeat(3000))
        expect(queries).toHaveLength(2)
        expect(queries.every(text => text.length <= 4096)).toBe(true)
        expect(queries[1]).toContain('지금 질문')
    })

    it('preserves semantic evidence when Bard-chan reorders existing candidates', () => {
        const semantic = { documentId: 'a', score: 0.8, contentHash: 'h', start: 90, end: 150 }
        expect(mergeWikiSemanticMatches([semantic], [{ documentId: 'a', score: 1 }, { documentId: 'b', score: 0.5 }]))
            .toEqual([{ ...semantic, score: 1 }, { documentId: 'b', score: 0.5 }])
    })
})
