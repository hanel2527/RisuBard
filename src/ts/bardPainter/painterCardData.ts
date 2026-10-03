import type { PainterBotData, PainterLibraryData } from './types'
import { botOutfitCatalog } from './library'

const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Imported presets start private. A card cannot grant permission to re-export local data. */
export function normalizePainterBotData(value: unknown): PainterBotData | undefined {
    const source = record(value)
    if (!source || (!Array.isArray(source.identities) && !Array.isArray(source.outfits))) return undefined
    const identities: PainterBotData['identities'] = []
    const identityIds = new Set<string>()
    const identitySources = new Map<string, Record<string, unknown>>()
    for (const candidate of Array.isArray(source.identities) ? source.identities : []) {
        const item = record(candidate)
        if (!item || !nonempty(item.id) || !nonempty(item.name) || typeof item.appearance !== 'string' || identityIds.has(item.id)) continue
        identityIds.add(item.id)
        identitySources.set(item.id, item)
        identities.push({
            id: item.id, name: item.name, appearance: item.appearance,
            ...(nonempty(item.note) ? { note: item.note } : {}),
            aliases: Array.isArray(item.aliases) ? [...new Set(item.aliases.filter(nonempty))] : [],
        })
    }
    const outfits: PainterBotData['outfits'] = []
    const outfitIds = new Set<string>()
    for (const candidate of Array.isArray(source.outfits) ? source.outfits : []) {
        const item = record(candidate)
        if (!item || !nonempty(item.id) || !nonempty(item.name) || typeof item.subjectId !== 'string'
            || (item.subjectId !== '' && !identityIds.has(item.subjectId)) || typeof item.clothing !== 'string' || outfitIds.has(item.id)) continue
        outfitIds.add(item.id)
        outfits.push({
            id: item.id, subjectId: item.subjectId, name: item.name, clothing: item.clothing,
            state: typeof item.state === 'string' ? item.state : '',
        })
    }
    for (const identity of identities) {
        const original = identitySources.get(identity.id)!
        const available = new Set(outfits.filter(item => item.subjectId === '' || item.subjectId === identity.id).map(item => item.id))
        if (Array.isArray(original.outfitIds)) identity.outfitIds = [...new Set(original.outfitIds.filter(nonempty).filter(id => available.has(id)))]
        if (nonempty(original.defaultOutfitId) && available.has(original.defaultOutfitId)
            && outfits.some(item => item.id === original.defaultOutfitId && (item.subjectId === identity.id || identity.outfitIds?.includes(item.id)))) {
            identity.defaultOutfitId = original.defaultOutfitId
        }
    }
    return { identities, outfits }
}

/** Public card projection, separate from the complete personal save/backup. Selected global outfits are snapshotted. */
export function exportPainterBotData(value: unknown, global?: PainterLibraryData): PainterBotData | undefined {
    let source = record(value)
    if (!source || (!Array.isArray(source.identities) && !Array.isArray(source.outfits))) return undefined
    if (Array.isArray(source.globalOutfits) && Array.isArray(source.outfits)) source = { ...source, outfits: botOutfitCatalog({ identities: [], outfits: source.outfits, globalOutfits: source.globalOutfits } as PainterBotData, global).outfits }
    const selected = (items: unknown[]) => items.filter(item => record(item)?.attachToCard === true)
    const data = normalizePainterBotData({
        identities: selected(Array.isArray(source.identities) ? source.identities : []),
        outfits: selected(Array.isArray(source.outfits) ? source.outfits : []),
    })
    return data && (data.identities.length || data.outfits.length) ? data : undefined
}
