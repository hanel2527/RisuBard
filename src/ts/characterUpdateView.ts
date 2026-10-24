import type { UpdateItem } from './characterUpdate'

// Body fields are always shown as blocks so both sides line up in the diff.
const blockKeys = new Set(['content', 'in', 'out'])
const longText = (key: string, value: string) => blockKeys.has(key) || value.includes('\n') || value.length > 60

/** Plain text of one side of an update item, for the line diff. */
export function updateValueText(value: unknown): string {
    if (value === undefined || value === null) return ''
    if (typeof value === 'string') return value
    if (Array.isArray(value)) {
        if (value.every(item => typeof item === 'string')) return value.join('\n---\n')
        return JSON.stringify(value, null, 2)
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        const lines: string[] = []
        const blocks: string[] = []
        for (const key of Object.keys(record).sort()) {
            const item = record[key]
            if (item === undefined || key === 'id' || key === 'loreCache') continue
            if (typeof item === 'string' && longText(key, item)) blocks.push(`[${key}]\n${item}`)
            else lines.push(`${key}: ${JSON.stringify(item)}`)
        }
        return [...lines, ...blocks].join('\n')
    }
    return JSON.stringify(value)
}

/** The entry's own name inside a list field: lore title, script comment, asset name. */
export function updateItemName(item: UpdateItem): string {
    if (!item.key) return ''
    if (item.field === 'extentions') return item.key
    const value = (item.mine ?? item.theirs) as any
    if (Array.isArray(value)) return String(value[0] ?? '')
    if (value && typeof value === 'object') return String(value.comment || value.name || value.key || '').trim()
    return ''
}
