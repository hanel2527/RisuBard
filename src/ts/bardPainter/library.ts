import { v4 as uuidv4 } from 'uuid'
import type { PainterBotData, PainterIdentity, PainterLibraryData, PainterOutfit } from './types'

const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

export function outfitsForIdentity(library: PainterLibraryData, identityId: string): PainterOutfit[] {
    const identity = library.identities.find(item => item.id === identityId)
    if (!identity) return []
    return library.outfits.filter(item => item.subjectId === identityId || (!item.subjectId && identity.outfitIds?.includes(item.id)))
}

/** Bot outfits plus the global outfits selected for the bot. Bot outfits win id collisions. */
export function botOutfitCatalog(bot: PainterBotData, global?: PainterLibraryData): PainterLibraryData {
    const local = new Set(bot.outfits.map(item => item.id))
    const refs = new Map((bot.globalOutfits ?? []).map(ref => [ref.id, ref]))
    const selected = (global?.outfits ?? []).filter(item => !item.subjectId && refs.has(item.id) && !local.has(item.id)).map(item => {
        const next: PainterOutfit = { ...item }
        if (refs.get(item.id)!.attachToCard === true) next.attachToCard = true
        else delete next.attachToCard
        return next
    })
    return { identities: bot.identities, outfits: [...bot.outfits, ...selected] }
}

function copyName(name: string, items: { name: string }[]): string {
    const base = name.trim()
    const names = new Set(items.map(item => item.name.trim().toLocaleLowerCase()))
    let candidate = base
    for (let i = 2; names.has(candidate.toLocaleLowerCase()); i++) candidate = `${base} (${i})`
    return candidate
}

export function copyPainterOutfit(outfit: PainterOutfit, targetOutfits: PainterOutfit[]): PainterOutfit {
    return { id: uuidv4(), subjectId: '', name: copyName(outfit.name, targetOutfits), clothing: outfit.clothing, state: outfit.state }
}

/** Outfits whose ids are in `linked` are referenced as-is instead of copied. */
export function copyPainterIdentity(source: PainterLibraryData, identityId: string, target: PainterLibraryData, linked = new Set<string>()): { identity: PainterIdentity; outfits: PainterOutfit[]; linkedIds: string[] } {
    const original = source.identities.find(item => item.id === identityId)
    if (!original) throw new Error('Character preset not found')
    const identity: PainterIdentity = {
        id: uuidv4(), name: copyName(original.name, target.identities), aliases: [...original.aliases], appearance: original.appearance,
    }
    const remap = new Map<string, string>()
    const outfits: PainterOutfit[] = []
    const linkedIds: string[] = []
    for (const outfit of outfitsForIdentity(source, identityId)) {
        if (!outfit.subjectId && linked.has(outfit.id)) { remap.set(outfit.id, outfit.id); linkedIds.push(outfit.id); continue }
        const copy = copyPainterOutfit(outfit, [...target.outfits, ...outfits])
        remap.set(outfit.id, copy.id)
        outfits.push(copy)
    }
    identity.outfitIds = [...remap.values()]
    if (original.defaultOutfitId && remap.has(original.defaultOutfitId)) identity.defaultOutfitId = remap.get(original.defaultOutfitId)
    return { identity, outfits, linkedIds }
}

type LoreEntry = { extentions?: unknown }

export function getPainterLoreIdentity(entry: LoreEntry): string | undefined {
    const id = record(record(record(entry.extentions)?.risubard)?.bardPainter)?.identityId
    return typeof id === 'string' && id.trim() ? id : undefined
}

/** Lore text and other vendors' metadata remain untouched. */
export function withPainterLoreIdentity<T extends LoreEntry>(entry: T, id?: string): T {
    const extensions = record(entry.extentions) ?? {}
    const risubard = record(extensions.risubard) ?? {}
    const painter = record(risubard.bardPainter) ?? {}
    if (!id && !Object.prototype.hasOwnProperty.call(painter, 'identityId')) return entry
    const nextPainter = { ...painter }
    if (id) nextPainter.identityId = id
    else delete nextPainter.identityId
    const nextRisu = { ...risubard }
    if (Object.keys(nextPainter).length) nextRisu.bardPainter = nextPainter
    else delete nextRisu.bardPainter
    const nextExtensions = { ...extensions }
    if (Object.keys(nextRisu).length) nextExtensions.risubard = nextRisu
    else delete nextExtensions.risubard
    return { ...entry, extentions: nextExtensions }
}

export function filterPainterLoreLinks<T extends LoreEntry>(entries: T[], identities: PainterIdentity[]): T[] {
    const ids = new Set(identities.map(item => item.id))
    return entries.map(entry => ids.has(getPainterLoreIdentity(entry) ?? '') ? entry : withPainterLoreIdentity(entry))
}
