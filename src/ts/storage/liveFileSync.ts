export interface LiveFileSnapshot {
    characters: Record<string, any>[]
    loreBook: any[]
}

export interface LiveFileSyncResult {
    revision: string
    etag: string | null
    snapshot?: LiveFileSnapshot
    error?: string
    recovery?: { path: string, conflicts: number }
}

export interface LiveFileConflict {
    characterId?: string
    field: string
    localValue: unknown
}

export function createLiveFileRefresh(options: {
    getInFlight(): Promise<void> | null
    setInFlight(value: Promise<void> | null): void
    isActive(): boolean
    sync(): Promise<void>
}) {
    return async () => {
        if (!options.isActive()) return
        while (options.getInFlight()) {
            // A failed poll must not permanently stop subsequent saves/refreshes.
            try { await options.getInFlight() } catch {}
        }
        if (!options.isActive()) return
        const operation = Promise.resolve().then(options.sync)
        options.setInFlight(operation)
        try { await operation } finally {
            if (options.getInFlight() === operation) options.setInFlight(null)
        }
    }
}

const runtimeFields = new Set(['chats', 'chatPage', 'chaId'])
const arrayDefaults = new Set(['globalLore', 'additionalAssets', 'emotionImages', 'customscript', 'triggerscript', 'alternateGreetings', 'tags', 'bias', 'chatFolders'])
const stringDefaults = new Set(['name', 'desc', 'firstMessage', 'notes', 'exampleMessage', 'creatorNotes', 'systemPrompt', 'postHistoryInstructions', 'additionalText', 'creator', 'characterVersion', 'personality', 'scenario', 'backgroundHTML', 'backgroundCSS'])
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value))
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Update metadata in place: streaming chats keep their existing objects. */
export function applyLiveFileSnapshot(
    current: LiveFileSnapshot,
    baseline: LiveFileSnapshot,
    remote: LiveFileSnapshot,
): { conflicts: LiveFileConflict[], characterIds: string[] } {
    const conflicts: LiveFileConflict[] = []
    const characterIds: string[] = []
    const merge = (local: Record<string, any>, previous: Record<string, any>, incoming: Record<string, any>, characterId?: string) => {
        for (const key of new Set([...Object.keys(previous), ...Object.keys(incoming)])) {
            if (runtimeFields.has(key) || equal(previous[key], incoming[key])) continue
            if (!equal(local[key], previous[key]) && !equal(local[key], incoming[key])) {
                conflicts.push({ ...(characterId ? { characterId } : {}), field: key, localValue: clone(local[key]) })
            }
            if (Object.hasOwn(incoming, key)) local[key] = clone(incoming[key])
            else if (characterId && arrayDefaults.has(key)) local[key] = []
            else if (characterId && stringDefaults.has(key)) local[key] = ''
            else delete local[key]
        }
    }
    for (const incoming of remote.characters) {
        const previous = baseline.characters.find(c => c.chaId === incoming.chaId)
        const local = current.characters.find(c => c.chaId === incoming.chaId)
        // Character creation/deletion remains an explicit application operation.
        if (!previous || !local) continue
        merge(local, previous, incoming, incoming.chaId)
        for (const key of new Set([...Object.keys(previous), ...Object.keys(incoming)])) {
            if (runtimeFields.has(key)) continue
            if (Object.hasOwn(incoming, key)) previous[key] = clone(incoming[key])
            else delete previous[key]
        }
        characterIds.push(incoming.chaId)
    }
    merge(current, { loreBook: baseline.loreBook }, { loreBook: remote.loreBook })
    baseline.loreBook = clone(remote.loreBook)
    return { conflicts, characterIds }
}
