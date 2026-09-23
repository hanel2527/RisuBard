export type DisplayNameEntry = string | { id?: string; chaId?: string; name?: string }

export function normalizeDisplayName(name: unknown): string {
    return typeof name === 'string'
        ? name.trim().normalize('NFC').toUpperCase().toLowerCase()
        : ''
}

export function hasDisplayNameCollision(
    name: string,
    existing: Iterable<DisplayNameEntry>,
    excludedId?: string,
): boolean {
    const normalized = normalizeDisplayName(name)
    if (!normalized) return false
    for (const entry of existing) {
        if (typeof entry === 'string') {
            if (normalizeDisplayName(entry) === normalized) return true
            continue
        }
        const isExcluded = excludedId !== undefined
            && (entry.id === excludedId || entry.chaId === excludedId)
        if (!isExcluded && normalizeDisplayName(entry.name) === normalized) return true
    }
    return false
}

export function createUniqueDisplayName(
    name: string,
    existing: Iterable<DisplayNameEntry>,
    excludedId?: string,
): string {
    const base = name.trim()
    if (!hasDisplayNameCollision(base, existing, excludedId)) return base

    let index = 2
    while (hasDisplayNameCollision(`${base} (${index})`, existing, excludedId)) index++
    return `${base} (${index})`
}
