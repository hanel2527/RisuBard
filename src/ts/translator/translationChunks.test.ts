import { describe, expect, it } from 'vitest'
import { splitTranslationText } from './translationChunks'

describe('character-sized plaintext translation', () => {
    it('fills requests to the character limit instead of splitting at paragraphs or HTML nodes', () => {
        const source = ('First sentence.\n\n<p>Next sentence.</p>{{asset::portrait}} ').repeat(400)
        const parts = splitTranslationText(source, 8000)
        expect(parts.map(part => part.text).join('')).toBe(source)
        expect(parts).toHaveLength(Math.ceil(source.length / 8000))
        for (const part of parts.slice(0, -1)) {
            expect(part.translate).toBe(true)
            expect(part.text.length).toBeGreaterThan(7960)
            expect(part.text.length).toBeLessThanOrEqual(8000)
        }
        expect(parts[0].text).toContain('Next sentence.</p>{{asset::portrait}} ')
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
