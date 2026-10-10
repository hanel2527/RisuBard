import { describe, expect, it } from 'vitest'
import { splitTranslationText } from './translationChunks'

describe('character-sized plaintext translation', () => {
    it('groups many paragraphs and assets while cutting at nearby line or sentence endings', () => {
        const source = ('First sentence.\n\n<p>Next sentence.</p>{{asset::portrait}} ').repeat(400)
        const parts = splitTranslationText(source, 8000)
        expect(parts.map(part => part.text).join('')).toBe(source)
        expect(parts).toHaveLength(3)
        for (const part of parts.slice(0, -1)) {
            expect(part.translate).toBe(true)
            expect(part.text.length).toBeLessThanOrEqual(8000)
            expect(part.text).toMatch(/[.!?\n]\s*$/)
        }
        expect(parts[0].text).toContain('Next sentence.</p>{{asset::portrait}} ')
    })

    it.each(['.', '!', '?', '。', '！', '？', '…'])('keeps sentence punctuation and closing quotes together: %s', punctuation => {
        const sentence = 'A'.repeat(7900) + punctuation + '” '
        const remaining = 'B'.repeat(500)
        const parts = splitTranslationText(sentence + remaining, 8000)
        expect(parts.map(part => part.text)).toEqual([sentence, remaining])
    })

    it('uses the closest natural boundary rather than an earlier newline', () => {
        const prefix = 'Opening line.\n' + 'A'.repeat(7880) + '. '
        const suffix = 'B'.repeat(500)
        expect(splitTranslationText(prefix + suffix, 8000).map(part => part.text)).toEqual([prefix, suffix])
    })

    it('recognizes CJK sentence endings without spaces between sentences', () => {
        const sentence = '先'.repeat(7900) + '。'
        const remaining = '後'.repeat(500) + '。'
        expect(splitTranslationText(sentence + remaining, 8000).map(part => part.text)).toEqual([sentence, remaining])
    })

    it.each([', ', '; ', '，', '；'])('uses clause punctuation when a sentence is longer than the cap: %s', punctuation => {
        const clause = 'A'.repeat(7900) + punctuation
        const remaining = 'B'.repeat(500)
        expect(splitTranslationText(clause + remaining, 8000).map(part => part.text)).toEqual([clause, remaining])
    })

    it('keeps CRLF line separators intact when the character cap falls between them', () => {
        const source = 'A'.repeat(7999) + '\r\n' + 'B'.repeat(8100)
        const parts = splitTranslationText(source, 8000)
        expect(parts.map(part => part.text).join('')).toBe(source)
        for (const part of parts) {
            expect(part.text.length).toBeLessThanOrEqual(8000)
            expect(part.text.endsWith('\r')).toBe(false)
            expect(part.text.startsWith('\n')).toBe(false)
        }
    })

    it('does not treat punctuation or newlines in asset attributes as prose boundaries after a previous cut', () => {
        const prefix = 'A'.repeat(7600) + '.\n'
        const image = `<img src="portrait.png" title="${'quoted. \n'.repeat(15)}">`
        const source = prefix + image + 'B'.repeat(8100)
        const parts = splitTranslationText(source, 8000)
        expect(parts.map(part => part.text).join('')).toBe(source)
        expect(parts[0].text).toBe(prefix)
        expect(parts[1].text.startsWith(image)).toBe(true)
        expect(parts[1].text.length).toBe(8000)
    })

    it('uses word whitespace without treating decimal points as sentence endings', () => {
        const prefix = 'A'.repeat(7900) + '3.14 '
        const suffix = 'B'.repeat(500)
        expect(splitTranslationText(prefix + suffix, 8000).map(part => part.text)).toEqual([prefix, suffix])
    })

    it('hard-splits only when a long source has no natural or word boundaries', () => {
        const source = '中'.repeat(16001)
        const parts = splitTranslationText(source, 8000)
        expect(parts.map(part => part.text).join('')).toBe(source)
        expect(parts.map(part => part.text.length)).toEqual([8000, 8000, 1])
    })

    it.each([
        '{{asset::portrait}}',
        '{{inlay::scene}}',
        '<img src="portrait.png" title="a > b">',
        '![portrait](https://example.test/portrait.png)',
        '&amp;',
    ])('does not cut inside source syntax at the size boundary: %s', syntax => {
        const source = 'A'.repeat(7998) + syntax + 'B'.repeat(8200)
        const parts = splitTranslationText(source, 8000)
        expect(parts.map(part => part.text).join('')).toBe(source)
        expect(parts[0].text).toBe('A'.repeat(7998))
        expect(parts[1].text.startsWith(syntax)).toBe(true)
        expect(parts[1].text.length).toBe(8000)
        expect(parts.every(part => part.translate)).toBe(true)
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

    it('retains an oversized encoded image without splitting or translating its bytes', () => {
        const image = `<img src="data:image/png;base64,${'A'.repeat(9000)}">`
        const source = `Before ${image} After`
        const parts = splitTranslationText(source, 8000)
        expect(parts).toEqual([
            { text: 'Before ', translate: true },
            { text: image, translate: false },
            { text: ' After', translate: true },
        ])
    })
})
