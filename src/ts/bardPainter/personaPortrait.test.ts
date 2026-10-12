import { describe, expect, it } from 'vitest'
import {
    buildPersonaPortraitImageRequest,
    buildPersonaPortraitMessages,
    parsePersonaPortraitFields,
    personaDescriptionHash,
    personaPainterIdentityFields,
    PERSONA_PORTRAIT_SIZE,
} from './personaPortrait'
import { PAINTER_STYLES } from './styles'

const fields = {
    composition: '1boy, solo, upper body, looking at viewer, simple background',
    appearance: 'black hair, red eyes, tall',
    clothing: 'black coat, white shirt',
    expression: 'calm smile',
}

describe('persona portrait', () => {
    it('sends the description as data and the current prompt only when revising', () => {
        const fresh = buildPersonaPortraitMessages({ name: '볼가', description: '# 볼가', instruction: '' })
        expect(JSON.parse(fresh[1].content)).toEqual({ persona: { name: '볼가', description: '# 볼가' }, instruction: '' })
        const revised = buildPersonaPortraitMessages({ name: '볼가', description: '# 볼가', instruction: '은발로', current: fields })
        expect(JSON.parse(revised[1].content).current).toEqual(fields)
        expect(() => buildPersonaPortraitMessages({ name: '볼가', description: '', instruction: '' })).toThrow()
        expect(() => buildPersonaPortraitMessages({ name: '볼가', description: '# 볼가', current: fields })).toThrow()
    })

    it('parses model JSON into single-line fields and requires appearance', () => {
        const parsed = parsePersonaPortraitFields('```json\n{"composition":"","appearance":"black hair,\\nred eyes","clothing":"coat","expression":"smile"}\n```')
        expect(parsed.appearance).toBe('black hair, red eyes')
        expect(parsed.composition).toContain('upper body')
        expect(() => parsePersonaPortraitFields('{"composition":"","appearance":"","clothing":"","expression":""}')).toThrow()
    })

    it('fills fields from a BardPainter identity with the same name or alias', () => {
        const library = {
            identities: [{ id: 'a', name: 'Volga Zethur', aliases: ['볼가'], appearance: 'black hair', defaultOutfitId: 'o' }],
            outfits: [{ id: 'o', subjectId: '', name: 'coat', clothing: 'black coat', state: 'wet' }],
        }
        expect(personaPainterIdentityFields(library, ' 볼가 ')).toMatchObject({ appearance: 'black hair', clothing: 'black coat, wet' })
        expect(personaPainterIdentityFields(library, 'someone')).toBeNull()
    })

    it('builds a square NovelAI request with the persona as one character block', () => {
        const request = buildPersonaPortraitImageRequest(fields, PAINTER_STYLES[0], undefined, 42)
        expect(request.parameters.width).toBe(PERSONA_PORTRAIT_SIZE.width)
        expect(request.parameters.height).toBe(PERSONA_PORTRAIT_SIZE.height)
        expect(request.parameters.seed).toBe(42)
        expect(request.input).toContain('upper body')
        expect(request.parameters.characterPrompts).toHaveLength(1)
        expect(request.parameters.characterPrompts[0].prompt).toContain('black coat')
    })

    it('detects description changes', () => {
        expect(personaDescriptionHash('a')).toBe(personaDescriptionHash('a'))
        expect(personaDescriptionHash('a')).not.toBe(personaDescriptionHash('b'))
    })
})
