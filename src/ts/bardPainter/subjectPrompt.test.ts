import { describe, expect, it } from 'vitest'
import type { PainterSubject } from './types'
import { migrateLegacyDraft, migrateLegacySubjectPrompt } from './subjectPrompt'

function subject(prompt?: string): PainterSubject {
    return { id: 'person', name: 'Example', aliases: [], kind: 'character', appearance: 'short hair', clothing: 'blue coat', state: 'wet', pose: 'standing', negative: '', ...(prompt === undefined ? {} : { prompt }) }
}

describe('legacy single prompt migration', () => {
    it('moves paragraphs into appearance, clothing and pose and keeps extra paragraphs in pose', () => {
        const value = subject(' long hair \r\n\r\n red jacket \r\n\r\n looking left\n raised hand\r\n\r\n extra direction ')
        expect(migrateLegacySubjectPrompt(value)).toBe(true)
        expect(value).toMatchObject({ appearance: 'long hair', clothing: 'red jacket', state: '', pose: 'looking left\n raised hand\r\n\r\n extra direction', appearanceEdited: true })
        expect(value).not.toHaveProperty('prompt')
    })
    it('leaves structured subjects untouched', () => {
        const value = subject()
        expect(migrateLegacySubjectPrompt(value)).toBe(false)
        expect(value).toEqual(subject())
    })
    it('migrates every subject of a draft and reports whether anything changed', () => {
        const draft = { rendering: '', scene: 'room', negative: '', subjects: [subject('only appearance'), subject()] }
        expect(migrateLegacyDraft(draft)).toBe(true)
        expect(draft.subjects[0]).toMatchObject({ appearance: 'only appearance', clothing: '', pose: '' })
        expect(migrateLegacyDraft(draft)).toBe(false)
        expect(migrateLegacyDraft(undefined)).toBe(false)
    })
})
