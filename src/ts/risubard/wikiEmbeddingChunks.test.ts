import { describe, expect, test } from 'vitest'
import { chunkWikiDocument } from './wikiEmbeddingChunks'

describe('wiki embedding chunks', () => {
    test('covers long paragraphs beyond 12000 with exact ranges and bounded overlap', () => {
        const content = '## Records\n\n' + 'A long chronicle. '.repeat(1600) + '\n\n### Secret\n\nThe hidden ledger.'
        const chunks = chunkWikiDocument({ id: 'archive', title: 'Archive', contentHash: 'hash', content })
        expect(chunks.at(-1)?.text).toContain('The hidden ledger.')
        expect(chunks.at(-1)?.start).toBeGreaterThan(12000)
        expect(chunks.every(chunk => chunk.text.length <= 1000)).toBe(true)
        expect(chunks.every(chunk => chunk.text.endsWith(content.slice(chunk.start, chunk.end)))).toBe(true)
        const long = chunks.filter(chunk => chunk.start >= content.indexOf('A long') && chunk.end <= content.indexOf('\n\n###'))
        expect(long.length).toBeGreaterThan(20)
        expect(long[1].start).toBe(long[0].end - 120)
        for (let i = 1; i < long.length; i++) expect(long[i].start).toBeLessThanOrEqual(long[i - 1].end)
    })
})
