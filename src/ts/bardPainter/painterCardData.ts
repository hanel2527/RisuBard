import type { PainterBotData } from './types'

const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Cards carry only validated bot-wide identities and outfits, never per-chat drafts or images. */
export function normalizePainterBotData(value: unknown): PainterBotData | undefined {
    const source = record(value)
    if (!source || !Array.isArray(source.identities)) return undefined
    const identities: PainterBotData['identities'] = []
    const identityIds = new Set<string>()
    for (const candidate of source.identities) {
        const item = record(candidate)
        if (!item || !nonempty(item.id) || !nonempty(item.name) || typeof item.appearance !== 'string' || identityIds.has(item.id)) continue
        identityIds.add(item.id)
        identities.push({
            id: item.id, name: item.name, appearance: item.appearance,
            aliases: Array.isArray(item.aliases) ? [...new Set(item.aliases.filter(nonempty))] : [],
        })
    }
    const outfits: PainterBotData['outfits'] = []
    const outfitIds = new Set<string>()
    for (const candidate of Array.isArray(source.outfits) ? source.outfits : []) {
        const item = record(candidate)
        if (!item || !nonempty(item.id) || !nonempty(item.name) || !nonempty(item.subjectId)
            || !identityIds.has(item.subjectId) || typeof item.clothing !== 'string' || outfitIds.has(item.id)) continue
        outfitIds.add(item.id)
        outfits.push({
            id: item.id, subjectId: item.subjectId, name: item.name, clothing: item.clothing,
            state: typeof item.state === 'string' ? item.state : '',
        })
    }
    return { identities, outfits }
}
