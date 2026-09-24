import type { PainterSubject } from './types'

type EditableSubject = PainterSubject & { prompt?: string }

export function subjectPromptText(subject: EditableSubject): string {
    return subject.prompt ?? [subject.appearance, [subject.clothing, subject.state].filter(Boolean).join(', '), subject.pose].join('\n\n')
}

function paragraphBoundaries(text: string) {
    const separator = /\r?\n[ \t]*\r?\n/g
    return { first: separator.exec(text), second: separator.exec(text) }
}

/** Keep the editor's exact text; structured fields remain available for preset saves. */
export function updateSubjectPrompt(subject: EditableSubject, text: string): void {
    const { first, second } = paragraphBoundaries(text)
    subject.prompt = text
    subject.appearance = (first ? text.slice(0, first.index) : text).trim()
    subject.clothing = (first ? text.slice(first.index + first[0].length, second?.index) : '').trim()
    subject.state = ''
    subject.pose = (second ? text.slice(second.index + second[0].length) : '').trim()
}

export function replaceSubjectAppearance(subject: EditableSubject, appearance: string): void {
    const text = subjectPromptText(subject)
    const { first } = paragraphBoundaries(text)
    // Preserve saved outfit state as its own field unless the user edits the full text.
    const clothing = subject.clothing
    const state = subject.state
    updateSubjectPrompt(subject, appearance + (first ? text.slice(first.index) : ''))
    subject.clothing = clothing
    subject.state = state
}

export function replaceSubjectOutfit(subject: EditableSubject, clothing: string, state: string): void {
    const text = subjectPromptText(subject)
    const { first, second } = paragraphBoundaries(text)
    const prefix = first ? text.slice(0, first.index + first[0].length) : `${text}\n\n`
    const suffix = second ? text.slice(second.index) : ''
    updateSubjectPrompt(subject, prefix + [clothing, state].filter(Boolean).join(', ') + suffix)
    subject.clothing = clothing
    subject.state = state
}
