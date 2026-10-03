import { v4 } from 'uuid'
import type { PainterBotData, PainterIdentity, PainterOutfit, PainterSubject } from './types'

const normalize = (name: string) => name.trim().toLocaleLowerCase()

export function reconcilePainterSubjects(subjects: PainterSubject[], bot: PainterBotData, previous: PainterSubject[]): PainterSubject[] {
    // Manual blocks already own IDs used by saved outfits. Register those IDs
    // without implicitly making their editable appearance a permanent default.
    const identities = [...bot.identities]
    for (const subject of previous) {
        if (subject.id && !identities.some((identity) => identity.id === subject.id)) {
            identities.push({ id: subject.id, name: subject.name, aliases: [...subject.aliases], appearance: '' })
        }
    }
    const used = new Set<string>()
    const result = subjects.map((subject) => {
        let identity = identities.find((item) => item.id === subject.id)
        if (!identity) {
            const names = new Set([subject.name, ...subject.aliases].map(normalize).filter(Boolean))
            const matches = identities.filter((item) => [item.name, ...item.aliases].some((name) => names.has(normalize(name))))
            if (matches.length === 1) identity = matches[0]
        }
        if (!identity || used.has(identity.id)) {
            identity = { id: v4(), name: subject.name, aliases: [...subject.aliases], appearance: '' }
            identities.push(identity)
        }
        used.add(identity.id)
        const locked = previous.find((item) => item.id === identity.id && item.locked)
        return locked ? { ...locked, aliases: [...locked.aliases] } : { ...subject, id: identity.id }
    })
    previous.forEach((subject, index) => {
        if (subject.locked && !used.has(subject.id)) {
            result.splice(Math.min(index, result.length), 0, { ...subject, aliases: [...subject.aliases] })
            used.add(subject.id)
        }
    })
    if (result.length > 22) throw new Error('잠긴 블록을 포함하면 대상이 22개를 넘습니다. 블록 수를 줄인 뒤 다시 작성해 주세요.')
    bot.identities.push(...identities.slice(bot.identities.length))
    return result
}

/**
 * Fill recognized subjects with saved preset text verbatim. `presets` must be the
 * identities that existed before reconciliation registered new blank ones.
 */
export function applyPainterPresets(subjects: PainterSubject[], presets: PainterIdentity[], outfitsFor: (identityId: string) => PainterOutfit[],
    previous: PainterSubject[], loreIdentityIds: ReadonlySet<string> = new Set()): PainterSubject[] {
    return subjects.map((source) => {
        if (source.locked) return source
        const subject: PainterSubject = { ...source, aliases: [...source.aliases] }
        delete subject.presetMatch
        const identity = subject.kind === 'character' ? presets.find((item) => item.id === subject.id) : undefined
        const before = previous.find((item) => item.id === subject.id)
        const outfit = identity && subject.outfitId ? outfitsFor(identity.id).find((item) => item.id === subject.outfitId) : undefined
        if (!outfit) delete subject.outfitId
        if (identity) {
            const names = new Set([subject.name, ...subject.aliases].map(normalize).filter(Boolean))
            subject.presetMatch = loreIdentityIds.has(identity.id) ? 'lore'
                : [identity.name, ...identity.aliases].some((name) => names.has(normalize(name))) ? 'name' : 'context'
            // A block already in the draft keeps its current text, including manual edits.
            if (identity.appearance.trim()) subject.appearance = before?.appearance.trim() ? before.appearance : identity.appearance
        }
        if (outfit) {
            const kept = before?.outfitId === outfit.id
            subject.clothing = kept ? before.clothing : outfit.clothing
            subject.state = [...new Set([kept ? before.state : outfit.state, subject.state].map((value) => value.trim()).filter(Boolean))].join(', ')
        }
        if (!subject.appearance.trim()) {
            if (!before?.appearance.trim()) throw new Error(`「${subject.name}」의 외형이 비어 있습니다. 캐릭터 프리셋에 기본 외형을 저장하거나 다시 작성해 주세요.`)
            subject.appearance = before.appearance
        }
        return subject
    })
}

export function capturePainterOutfit(subject: PainterSubject, name: string, includeState: boolean): PainterOutfit {
    if (!name.trim() || !subject.id || !subject.clothing.trim()) throw new Error('의상 이름과 의상 프롬프트를 입력해 주세요.')
    return { id: v4(), subjectId: subject.id, name: name.trim(), clothing: subject.clothing, state: includeState ? subject.state : '' }
}

export function promotePainterOutfit(outfit: PainterOutfit): PainterOutfit {
    const copy = { ...outfit, id: v4() }
    delete copy.attachToCard
    return copy
}
