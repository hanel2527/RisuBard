import { describe, expect, it } from 'vitest'
import type { PainterSubject } from './types'
import { replaceSubjectAppearance, replaceSubjectOutfit, subjectPromptText, updateSubjectPrompt } from './subjectPrompt'

function subject(): PainterSubject & { prompt?: string } {
    return { id: 'person', name: 'Example', aliases: [], kind: 'character', appearance: 'short hair', clothing: 'blue coat', state: 'wet', pose: 'standing, smiling', negative: '' }
}

describe('single subject prompt', () => {
    it('shows legacy appearance, outfit and pose in separate paragraphs', () => {
        expect(subjectPromptText(subject())).toBe('short hair\n\nblue coat, wet\n\nstanding, smiling')
    })
    it('keeps user formatting verbatim while exposing paragraph sections to preset saves', () => {
        const value = subject()
        const prompt = ' long hair \r\n\r\n red jacket \r\n\r\n looking left\n raised hand\r\n\r\n extra direction '
        updateSubjectPrompt(value, prompt)
        expect(subjectPromptText(value)).toBe(prompt)
        expect(value).toMatchObject({ appearance: 'long hair', clothing: 'red jacket', state: '', pose: 'looking left\n raised hand\r\n\r\n extra direction' })
        updateSubjectPrompt(value, '')
        expect(subjectPromptText(value)).toBe('')
        expect(value).toMatchObject({ appearance: '', clothing: '', state: '', pose: '' })
    })
    it('replaces only the appearance paragraph when loading a character', () => {
        const value = subject()
        updateSubjectPrompt(value, 'old appearance\n\n coat, wet \n\n looking left\n raised hand\n\nextra')
        replaceSubjectAppearance(value, 'long hair, green eyes')
        expect(subjectPromptText(value)).toBe('long hair, green eyes\n\n coat, wet \n\n looking left\n raised hand\n\nextra')
    })
    it('loads an outfit without losing freeform pose or its separate saved condition', () => {
        const value = subject()
        updateSubjectPrompt(value, 'short hair\n\nold outfit\n\n crouching \n\n extra composition ')
        replaceSubjectOutfit(value, 'winter coat', 'snowy')
        expect(subjectPromptText(value)).toBe('short hair\n\nwinter coat, snowy\n\n crouching \n\n extra composition ')
        expect(value).toMatchObject({ clothing: 'winter coat', state: 'snowy', appearance: 'short hair', pose: 'crouching \n\n extra composition' })
    })
    it('appends a clothing paragraph when a freeform prompt has only appearance', () => {
        const value = subject()
        updateSubjectPrompt(value, 'short hair, standing')
        replaceSubjectOutfit(value, 'travel cape', '')
        expect(subjectPromptText(value)).toBe('short hair, standing\n\ntravel cape')
        expect(value.pose).toBe('')
    })
    it('preserves empty paragraph slots for legacy subjects without clothes', () => {
        const value = { ...subject(), clothing: '', state: '' }
        replaceSubjectOutfit(value, 'formal suit', '')
        expect(subjectPromptText(value)).toBe('short hair\n\nformal suit\n\nstanding, smiling')
    })
})
