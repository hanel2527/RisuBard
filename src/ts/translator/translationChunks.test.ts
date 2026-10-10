import { describe, expect, it } from 'vitest'
import { splitTranslationText } from './translationChunks'

describe('bounded translation text', () => {
    it('splits at sentence boundaries and retains the separators between translated fragments', () => {
        const source = 'First sentence. Second sentence. Third sentence.'
        const parts = splitTranslationText(source, 20)
        expect(parts.filter(part => part.translate).map(part => part.text)).toEqual([
            'First sentence.', 'Second sentence.', 'Third sentence.',
        ])
        expect(parts.filter(part => !part.translate).map(part => part.text)).toEqual([' ', ' '])
    })

    it('bounds a paragraph without whitespace and keeps both surrounding paragraph breaks', () => {
        const source = `Opening line.\n\n${'中'.repeat(71)}\n\nClosing line.`
        const parts = splitTranslationText(source, 17)
        expect(parts.map(part => part.text).join('')).toBe(source)
        expect(parts.filter(part => part.translate).map(part => part.text)).toEqual([
            'Opening line.', '中'.repeat(17), '中'.repeat(17), '中'.repeat(17), '中'.repeat(17), '中'.repeat(3), 'Closing line.',
        ])
        expect(parts.filter(part => !part.translate).map(part => part.text)).toEqual(['\n\n', '\n\n'])
    })

    it('does not lose or split surrogate pairs at a hard character boundary', () => {
        const source = '😀'.repeat(17)
        const parts = splitTranslationText(source, 5)
        expect(parts.map(part => part.text).join('')).toBe(source)
        for (const part of parts) {
            expect(part.text.length).toBeLessThanOrEqual(5)
            expect(part.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
        }
    })

    it('keeps large code and source markup verbatim rather than sending partial tags or macros', () => {
        const protectedData = [
            '<div title="a > b" data-id="scene">',
            `<script>${'const value = 1;'.repeat(30)}</script>`,
            `<style>${'.scene { color: red; }'.repeat(30)}</style>`,
            '{{inlay::scene}}',
            '`const inline = true;`',
            '\n```js\n' + 'const value = 2;\n'.repeat(30) + '```\n',
            '&amp;',
            '</div>',
        ]
        const source = protectedData.join('Natural language sentence. '.repeat(4))
        const parts = splitTranslationText(source, 40)
        const literals = parts.filter(part => !part.translate).map(part => part.text).join('')
        expect(parts.map(part => part.text).join('')).toBe(source)
        for (const protectedPart of protectedData) expect(literals).toContain(protectedPart)
        for (const part of parts.filter(part => part.translate)) {
            expect(part.text.length).toBeLessThanOrEqual(40)
            expect(part.text).not.toMatch(/<|>|\{\{|`|const |color:/)
        }
    })
})
