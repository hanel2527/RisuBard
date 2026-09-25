import { describe, expect, it } from 'vitest'
import { emphasisAppearance, tokenizePromptEmphasis } from './emphasis'

function weightAt(source: string, text: string) {
    const offset = source.indexOf(text)
    let cursor = 0
    for (const part of tokenizePromptEmphasis(source)) {
        cursor += part.text.length
        if (cursor > offset) return part.weight
    }
    throw new Error(`Missing text: ${text}`)
}

describe('NovelAI prompt emphasis', () => {
    it('keeps ordinary text, literal HTML and empty input intact', () => {
        const source = '1girl, <img src=x onerror=alert(1)> & "words"\r\n한글\n'
        expect(tokenizePromptEmphasis(source)).toEqual([{ text: source, weight: 1 }])
        expect(tokenizePromptEmphasis('')).toEqual([])
    })

    it('weights numeric sections and resets at bare double colons', () => {
        const source = 'normal, 1.5::rain, night ::, .5::coat ::, +2::shoes::, plain'
        expect(weightAt(source, 'normal')).toBe(1)
        expect(weightAt(source, 'rain')).toBe(1.5)
        expect(weightAt(source, 'coat')).toBe(.5)
        expect(weightAt(source, 'shoes')).toBe(2)
        expect(weightAt(source, 'plain')).toBe(1)
    })

    it('supports negative, zero and unclosed numeric sections', () => {
        const source = '-3::hat::, 0::rain::, -.5::monochrome'
        expect(weightAt(source, 'hat')).toBe(-3)
        expect(weightAt(source, 'rain')).toBe(0)
        expect(weightAt(source, 'monochrome')).toBe(-.5)
    })

    it('combines nested bracket multipliers and restores the surrounding weight', () => {
        const source = 'plain {red {{hair}} eyes} plain2 [blue [[coat]] shoes] plain3'
        expect(weightAt(source, 'red')).toBeCloseTo(1.05)
        expect(weightAt(source, 'hair')).toBeCloseTo(1.05 ** 3)
        expect(weightAt(source, 'eyes')).toBeCloseTo(1.05)
        expect(weightAt(source, 'plain2')).toBe(1)
        expect(weightAt(source, 'blue')).toBeCloseTo(1 / 1.05)
        expect(weightAt(source, 'coat')).toBeCloseTo(1 / 1.05 ** 3)
        expect(weightAt(source, 'plain3')).toBe(1)
    })

    it('applies unmatched bracket effects and resets all open effects', () => {
        const source = ']strong::plain }weak::normal {{{open::reset'
        expect(weightAt(source, 'strong')).toBeCloseTo(1.05)
        expect(weightAt(source, 'plain')).toBe(1)
        expect(weightAt(source, 'weak')).toBeCloseTo(1 / 1.05)
        expect(weightAt(source, 'normal')).toBe(1)
        expect(weightAt(source, 'open')).toBeCloseTo(1.05 ** 3)
        expect(weightAt(source, 'reset')).toBe(1)
    })

    it('allows numeric sections to change weight without a closing marker', () => {
        const source = '2::strong .5::weak 1::plain'
        expect(weightAt(source, 'strong')).toBe(2)
        expect(weightAt(source, 'weak')).toBe(.5)
        expect(weightAt(source, 'plain')).toBe(1)
    })

    it('sets an absolute numeric weight and applies subsequent brackets to it', () => {
        const source = '{{2::red [hair] eyes::plain'
        expect(weightAt(source, 'red')).toBe(2)
        expect(weightAt(source, 'hair')).toBeCloseTo(2 / 1.05)
        expect(weightAt(source, 'eyes')).toBe(2)
        expect(weightAt(source, 'plain')).toBe(1)
    })

    it('keeps escaped delimiters literal', () => {
        const source = String.raw`\{literal\} \[brackets\] \1.5::normal 2\::plain \\{strong}`
        expect(weightAt(source, 'literal')).toBe(1)
        expect(weightAt(source, 'brackets')).toBe(1)
        expect(weightAt(source, 'normal')).toBe(1)
        expect(weightAt(source, 'plain')).toBe(1)
        expect(weightAt(source, 'strong')).toBeCloseTo(1.05)
    })

    it('does not parse a suffix of a malformed decimal as a weight', () => {
        for (const marker of ['1.2.3::', '--2::', '+-2::', '..5::', '.::']) {
            expect(weightAt(`${marker}plain`, 'plain')).toBe(1)
        }
    })

    it('keeps weights finite for huge numbers and deep nesting, then recovers', () => {
        const source = `${'9'.repeat(400)}::huge::${'{'.repeat(16000)}deep${'}'.repeat(16000)}normal`
        const parts = tokenizePromptEmphasis(source)
        expect(parts.every(part => Number.isFinite(part.weight))).toBe(true)
        expect(weightAt(source, 'normal')).toBe(1)
        expect(parts.map(part => part.text).join('')).toBe(source)
    })

    it('reconstructs input exactly and merges consecutive parts of equal weight', () => {
        for (const source of ['a {b [c] d} e', '1::all:: plain', '2::rain\n\n::', '\\{\\[::\\', '🤍{{눈}}\r\n']) {
            const parts = tokenizePromptEmphasis(source)
            expect(parts.map(part => part.text).join('')).toBe(source)
            expect(parts.every(part => part.text.length > 0)).toBe(true)
            for (let index = 1; index < parts.length; index++) {
                expect(parts[index].weight).not.toBe(parts[index - 1].weight)
            }
        }
    })
})

describe('prompt emphasis appearance', () => {
    it('does not highlight neutral weights', () => {
        expect(emphasisAppearance(1)).toEqual({ tone: 'neutral', opacity: 0 })
    })

    it('progressively highlights stronger and weaker values with capped opacity', () => {
        expect(emphasisAppearance(1.05).tone).toBe('strong')
        expect(emphasisAppearance(2).opacity).toBeGreaterThan(emphasisAppearance(1.05).opacity)
        expect(emphasisAppearance(.5).tone).toBe('weak')
        expect(emphasisAppearance(0).tone).toBe('weak')
        expect(emphasisAppearance(-3).tone).toBe('weak')
        expect(emphasisAppearance(-3).opacity).toBeGreaterThan(emphasisAppearance(.5).opacity)
        for (const weight of [1.00001, 1.05, 100000, .99999, .5, 0, -100000]) {
            const { opacity } = emphasisAppearance(weight)
            expect(opacity).toBeGreaterThanOrEqual(.08)
            expect(opacity).toBeLessThanOrEqual(.42)
        }
    })

    it('does not produce invalid styles for nonfinite input', () => {
        for (const weight of [Number.NaN, Infinity, -Infinity]) {
            expect(Number.isFinite(emphasisAppearance(weight).opacity)).toBe(true)
        }
    })
})
