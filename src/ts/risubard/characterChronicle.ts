import { normalizeWikiLinkKey, type WikiDocument } from './wikiLink'
import { extractStoryArcLinks } from './storyArcView'
import { oocTurnIndices } from './oocTurns'
import type { HistoricalSourceMessage } from './historicalSourceRecall'
import type { StorySourceRef } from './storySoFar'

export interface CharacterChronicleEntry {
    id: string
    title: string
    recorded: string
    storyTime?: string
    excerpt: string
    source: StorySourceRef
    missingSourceCount: number
}

export const CHARACTER_CHRONICLE_PAGE_SIZE = 20

/** Callers supply only the catalog visible in the current chat scope. */
export function buildCharacterChronicle(
    documents: readonly WikiDocument[],
    characterId: string,
    messages?: readonly HistoricalSourceMessage[],
    ignoreOocTurns = true,
) {
    const active = documents.filter(d => d.status === 'active' && d.contextMode !== 'never')
    const byId = new Map(documents.map(d => [d.id, d]))
    const byName = new Map<string, Set<string>>()
    // Exclusion must not turn a previously ambiguous name into a guessed identity.
    for (const d of documents) {
        for (const name of [d.title, ...(d.aliases ?? [])]) {
            const key = normalizeWikiLinkKey(name)
            if (!key) continue
            const owners = byName.get(key) ?? new Set<string>()
            owners.add(d.id)
            byName.set(key, owners)
        }
    }
    const resolve = (target: string): Set<string> => byId.has(target.trim())
        ? new Set([target.trim()])
        : byName.get(normalizeWikiLinkKey(target)) ?? new Set()
    const targets = (d: WikiDocument) => new Set([
        ...d.links,
        ...extractStoryArcLinks(d.content).map(link => link.target),
    ])
    const backlinks = new Map<string, Set<string>>()
    const ambiguousBacklinks = new Set<string>()
    for (const character of active.filter(d => d.type === 'character')) {
        for (const target of targets(character)) {
            const owners = resolve(target)
            for (const id of owners) {
                if (byId.get(id)?.type !== 'event') continue
                if (owners.size !== 1) {
                    if (character.id === characterId) ambiguousBacklinks.add(id)
                    continue
                }
                const ids = backlinks.get(id) ?? new Set<string>()
                ids.add(character.id)
                backlinks.set(id, ids)
            }
        }
    }
    const eligible = new Set<string>()
    const excluded = new Set<string>()
    if (messages) {
        const boundary = messages.findLastIndex(m => m.disabled === 'allBefore')
        const ooc = oocTurnIndices(messages, ignoreOocTurns)
        messages.forEach((m, i) => {
            if (typeof m.chatId !== 'string' || !m.chatId.trim()) return
            if (i <= boundary || ooc.has(i) || m.disabled || m.isComment
                || (m.role !== 'user' && m.role !== 'char') || typeof m.data !== 'string') {
                excluded.add(m.chatId)
            } else eligible.add(m.chatId)
        })
    }
    const entries: CharacterChronicleEntry[] = []
    let ambiguousCount = 0
    let unlinkedCount = 0
    for (const event of active) {
        if (event.type !== 'event' || event.sourceMessageIds.some(id => excluded.has(id))) continue
        const characters = new Set(backlinks.get(event.id))
        let ambiguous = ambiguousBacklinks.has(event.id)
        for (const target of targets(event)) {
            const owners = resolve(target)
            if (owners.size > 1) {
                if (owners.has(characterId)) ambiguous = true
            } else {
                const id = owners.values().next().value
                if (id && byId.get(id)?.type === 'character') characters.add(id)
            }
        }
        if (ambiguous) ambiguousCount += 1
        if (characters.size === 0) unlinkedCount += 1
        if (!characters.has(characterId)) continue
        const ids = [...new Set(event.sourceMessageIds)]
        const sourceIds = ids.filter(id => !id.startsWith('inherited:')
            && (!messages || eligible.has(id)))
        const time = event.retrievalMetadata?.storyTime
        // Preview only: the complete canonical document stays accessible through its ID.
        const preview = event.content.replace(/^#{1,6}\s+.*$/gm, '')
            .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => label ?? target)
            .replace(/\s+/g, ' ').trim()
        entries.push({
            id: event.id, title: event.title, recorded: event.created ?? event.updated,
            storyTime: time?.precision === 'explicit' && time.day !== null
                ? `${time.day}일차: ${time.evidence}` : undefined,
            excerpt: preview.length > 360 ? `${preview.slice(0, 360)}…` : preview,
            source: { kind: 'chat', messageIds: sourceIds },
            missingSourceCount: ids.length - sourceIds.length,
        })
    }
    entries.sort((a, b) => a.recorded.localeCompare(b.recorded) || a.id.localeCompare(b.id))
    return { entries, ambiguousCount, unlinkedCount }
}

export function chroniclePage(entries: readonly CharacterChronicleEntry[], requestedPage: number) {
    const pageCount = Math.max(1, Math.ceil(entries.length / CHARACTER_CHRONICLE_PAGE_SIZE))
    const page = Math.max(0, Math.min(pageCount - 1, Math.trunc(requestedPage) || 0))
    return { page, pageCount, entries: entries.slice(page * CHARACTER_CHRONICLE_PAGE_SIZE, (page + 1) * CHARACTER_CHRONICLE_PAGE_SIZE) }
}
