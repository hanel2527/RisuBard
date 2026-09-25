import { describe, expect, test } from 'vitest'
import { chunkWikiDocument } from './wikiEmbeddingChunks'

describe('wiki embedding chunks', () => {
    test('does not offer bare headings as narrative evidence', () => {
        const content = '## 츠구\r\n\r\n### 약속\r\n\r\n역에 가겠다는 약속은 하지 않았다.'
        const chunks = chunkWikiDocument({ id: 'tsugu', title: '츠구', contentHash: 'hash', content })
        expect(chunks.map(chunk => content.slice(chunk.start, chunk.end)))
            .toEqual(['역에 가겠다는 약속은 하지 않았다.'])
        expect(chunks[0].text).toBe('츠구\n### 약속\n\n역에 가겠다는 약속은 하지 않았다.')
        expect(chunkWikiDocument({ id: 'empty', title: 'Empty', contentHash: 'h',
            content: '## Empty\n\n### Current State\n\n### History' })).toEqual([])
    })

    test('preserves cached passage text and offsets when a heading shares a paragraph with its body', () => {
        const content = '## 츠구\r\n첫 만남.\r\n### 약속\r\n그런 약속은 하지 않았다.\r\n\r\n다음 문단.'
        const chunks = chunkWikiDocument({ id: 'tsugu', title: '츠구', contentHash: 'hash', content })
        expect(chunks.map(chunk => content.slice(chunk.start, chunk.end))).toEqual([
            '## 츠구\r\n첫 만남.', '### 약속\r\n그런 약속은 하지 않았다.', '다음 문단.',
        ])
        expect(chunks.map(chunk => chunk.text)).toEqual([
            '츠구\n## 츠구\n\n## 츠구\r\n첫 만남.',
            '츠구\n### 약속\n\n### 약속\r\n그런 약속은 하지 않았다.',
            '츠구\n### 약속\n\n다음 문단.',
        ])
    })

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
