/** chatId is the stable ID on a chat message, not the containing chat's ID. */
export interface EventOrderMessage {
    chatId?: string
    role: string
}

interface EventSource {
    id: string
    sourceMessageIds?: readonly string[]
    created?: string
    updated?: string
}

export function hasOnlyInheritedSources(event: Pick<EventSource, 'sourceMessageIds'>): boolean {
    return (event.sourceMessageIds?.length ?? 0) > 0
        && event.sourceMessageIds!.every(id => id.startsWith('inherited:'))
}

/** Resolve positions at read time so deleting a turn cannot stale stored indices. */
export function createEventOrder(messages: readonly EventOrderMessage[] = []) {
    const positions = new Map<string, { index: number; assistant: boolean }>()
    const ambiguous = new Set<string>()
    messages.forEach((message, index) => {
        const id = message.chatId
        if (!id || id.startsWith('inherited:')) return
        if (positions.has(id)) ambiguous.add(id)
        positions.set(id, { index, assistant: message.role === 'char' })
    })
    const position = (event: Pick<EventSource, 'sourceMessageIds'>): number | undefined => {
        let assistant: number | undefined
        let other: number | undefined
        let missing = false
        for (const id of event.sourceMessageIds ?? []) {
            if (ambiguous.has(id)) return undefined
            const source = positions.get(id)
            if (!source) {
                missing = true
                continue
            }
            if (source.assistant) assistant = Math.min(assistant ?? Infinity, source.index)
            else other = Math.min(other ?? Infinity, source.index)
        }
        // Several assistant turns can share a user message. Prefer response IDs.
        return assistant ?? (missing ? undefined : other)
    }
    const compare = (left: EventSource, right: EventSource, newestFirst = false): number => {
        const a = position(left)
        const b = position(right)
        if (a === undefined && b !== undefined) return 1
        if (a !== undefined && b === undefined) return -1
        const direction = newestFirst ? -1 : 1
        if (a !== undefined && b !== undefined) {
            return direction * (a - b) || left.id.localeCompare(right.id)
        }
        return direction * (left.created ?? left.updated ?? '')
            .localeCompare(right.created ?? right.updated ?? '')
            || left.id.localeCompare(right.id)
    }
    return { position, compare }
}
