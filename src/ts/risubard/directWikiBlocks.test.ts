import { describe, expect, test } from 'vitest'
import { applyDirectWikiBlocks, splitDirectWikiBlocks } from './directWikiBlocks'

describe('direct wiki source blocks', () => {
    test('retains exact source bytes and recognizes only unfenced headings', async () => {
        const source = '## 제목\r\n\r\n### 비밀\r\n첫 문단.\r\n```md\r\n### 가짜\r\n```\r\n끝.\r\n'
        const blocks = await splitDirectWikiBlocks(source, 100)
        expect(blocks.map((block) => block.heading)).toEqual(['## 제목', '### 비밀'])
        expect(blocks[1].markdown).toContain('### 비밀\r\n첫 문단.')
        expect(blocks[1].markdown).toContain('### 가짜')
        expect(applyDirectWikiBlocks(source, blocks, new Map(blocks.map((block) => [block.blockId, null])))).toBe(source)
        expect(await splitDirectWikiBlocks(source, 100)).toEqual(blocks)
        const replacements = new Map(blocks.map((block) => [block.blockId, null as string | null]))
        replacements.set(blocks[1].blockId, '수정.\r\n')
        expect(applyDirectWikiBlocks(source, blocks, replacements)).toBe('## 제목\r\n\r\n수정.\r\n')
    })

    test('splits a long single H3 into distinct snapshot blocks without splitting links or surrogate pairs', async () => {
        const source = '## 제목\n### 비밀\n' + '가나다😀 [[출처 문서|표시]] '.repeat(50)
        const blocks = await splitDirectWikiBlocks(source, 80)
        expect(blocks.length).toBeGreaterThan(4)
        expect(new Set(blocks.map((block) => block.blockId)).size).toBe(blocks.length)
        expect(blocks.every((block) => block.heading === '### 비밀')).toBe(true)
        expect(blocks.map((block) => block.markdown).join('')).toBe(source.slice('## 제목\n'.length))
        for (const block of blocks) {
            expect(block.contentHash).toMatch(/^[0-9a-f]{64}$/)
            expect(block.markdown.match(/\[\[/g)?.length ?? 0).toBe(block.markdown.match(/\]\]/g)?.length ?? 0)
            expect(block.markdown).not.toMatch(/[\uD800-\uDFFF]/u)
        }
        const updated = await splitDirectWikiBlocks(source.replace('가나다', '변경됨'), 80)
        expect(updated[0].blockId).not.toBe(blocks[0].blockId)
    })

    test('rejects changed source and incomplete replacement coverage', async () => {
        const source = '## 제목\n원문.'
        const blocks = await splitDirectWikiBlocks(source, 80)
        expect(() => applyDirectWikiBlocks(source, blocks, new Map())).toThrow(/처리하지 않은/)
        expect(() => applyDirectWikiBlocks(source.replace('원문', '다름'), blocks,
            new Map([[blocks[0].blockId, '교체']]))).toThrow(/변경/)
    })
})
