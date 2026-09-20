export const OOC_TURN_MARKER = '<!-- OOC_turn -->'

export function preserveOocTurnMarker(original: string, processed: string): string {
    return original.includes(OOC_TURN_MARKER) && !processed.includes(OOC_TURN_MARKER)
        ? `${OOC_TURN_MARKER}\n${processed}`
        : processed
}

interface MessageLike {
    role?: unknown
    data?: unknown
    disabled?: unknown
    isComment?: unknown
    chatId?: unknown
}

export function buildOocGroups<T extends MessageLike>(messages: readonly T[]) {
    type Entry = { message: T; index: number; turn?: number }
    const groups: { id: string; label: string; startTurn?: number; endTurn?: number; entries: Entry[] }[] = []
    let turn = 0
    let userIndex: number | undefined
    let previousWasOoc = false
    for (const [index, message] of messages.entries()) {
        if (message.isComment) continue
        if (message.role === 'user') userIndex = index
        if (message.role !== 'char') continue
        if (!message.disabled) turn += 1
        if (!isOocAssistantTurn(message)) {
            if (!message.disabled) previousWasOoc = false
            continue
        }
        const messageTurn = message.disabled ? undefined : turn
        let group = previousWasOoc ? groups.at(-1) : undefined
        if (!group) {
            group = { id: String(message.chatId || index), label: '', startTurn: messageTurn, endTurn: messageTurn, entries: [] }
            groups.push(group)
        }
        if (messageTurn !== undefined) {
            group.startTurn ??= messageTurn
            group.endTurn = messageTurn
        }
        if (userIndex !== undefined && !group.entries.some(entry => entry.index === userIndex)) {
            group.entries.push({ message: messages[userIndex], index: userIndex, turn: messageTurn })
        }
        group.entries.push({ message, index, turn: messageTurn })
        group.label = group.startTurn === undefined ? `메시지 ${index + 1}`
            : group.startTurn === group.endTurn ? String(group.startTurn) : `${group.startTurn}–${group.endTurn}`
        previousWasOoc = true
    }
    return groups
}

export function isOocAssistantTurn(message: MessageLike): boolean {
    return message.role === 'char' && typeof message.data === 'string'
        && message.data.includes(OOC_TURN_MARKER)
}

/** Indices refer to the original transcript; no message or saved status is mutated. */
export function oocTurnIndices(messages: readonly MessageLike[], ignore = true, includeInactive = false): Set<number> {
    const excluded = new Set<number>()
    if (!ignore) return excluded
    let userIndex: number | undefined
    for (const [index, message] of messages.entries()) {
        if ((!includeInactive && message.disabled) || message.isComment) continue
        if (message.role === 'user') userIndex = index
        if (isOocAssistantTurn(message)) {
            excluded.add(index)
            if (userIndex !== undefined) excluded.add(userIndex)
        }
    }
    return excluded
}
