import { v4 } from 'uuid'
import type { PainterBotData, PainterOutfit, PainterSubject } from './types'

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

export function capturePainterOutfit(subject: PainterSubject, name: string, includeState: boolean): PainterOutfit {
    if (!name.trim() || !subject.id || !subject.clothing.trim()) throw new Error('의상 이름과 의상 프롬프트를 입력해 주세요.')
    return { id: v4(), subjectId: subject.id, name: name.trim(), clothing: subject.clothing, state: includeState ? subject.state : '' }
}

export function promotePainterOutfit(outfit: PainterOutfit): PainterOutfit {
    return { ...outfit, id: v4() }
}
