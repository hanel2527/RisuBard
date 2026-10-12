import type { PainterDraft, PainterSubject } from './types'

/**
 * Older drafts kept one freeform character prompt split by blank lines into appearance,
 * clothing and pose. Move that text into the separate fields once; the extra paragraphs
 * stay with the pose so no user text is lost.
 */
export function migrateLegacySubjectPrompt(subject: PainterSubject): boolean {
    if (typeof subject.prompt !== 'string') return false
    const text = subject.prompt
    const separator = /\r?\n[ \t]*\r?\n/g
    const first = separator.exec(text), second = separator.exec(text)
    subject.appearance = (first ? text.slice(0, first.index) : text).trim()
    subject.clothing = (first ? text.slice(first.index + first[0].length, second?.index) : '').trim()
    subject.state = ''
    subject.pose = (second ? text.slice(second.index + second[0].length) : '').trim()
    // The old editor's text was the user's own; keep it over saved preset text.
    if (subject.appearance) subject.appearanceEdited = true
    delete subject.prompt
    return true
}

export function migrateLegacyDraft(draft: PainterDraft | undefined): boolean {
    let changed = false
    for (const subject of draft?.subjects ?? []) changed = migrateLegacySubjectPrompt(subject) || changed
    return changed
}
