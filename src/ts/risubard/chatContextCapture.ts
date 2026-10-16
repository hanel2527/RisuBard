// Keeps what the last main request of a watched chat injected: the lorebook
// entries that fired and the wiki or memory sources. The play mode of the
// Character Assistant reads it after each turn. Memory only, and only for chats
// someone is watching, so ordinary chats hold nothing.

import type { RequestInjectionSource } from '../status/requestStatus'

export interface CapturedChatContext {
    /** Names of the lorebook entries in the request, in prompt order, without repeats. */
    lorebook: string[]
    /** Wiki and memory sources with their text. */
    wiki: { name: string; content: string }[]
}

const watched = new Set<string>()
const captured = new Map<string, CapturedChatContext>()

export function watchChatContext(chatId: string): void {
    watched.add(chatId)
    captured.delete(chatId)
}

export function unwatchChatContext(chatId: string): void {
    watched.delete(chatId)
    captured.delete(chatId)
}

export function collectChatContext(messages: { requestStatusSources?: RequestInjectionSource[] }[]): CapturedChatContext {
    const lorebook: string[] = []
    const wiki: CapturedChatContext['wiki'] = []
    for (const message of messages) {
        for (const source of message.requestStatusSources ?? []) {
            if (source.kind === 'lorebook' || source.kind === 'grimoire' || source.kind === 'grimoireRequired') {
                const name = source.name?.trim() || '이름 없는 로어북'
                if (!lorebook.includes(name)) lorebook.push(name)
            }
            else if ((source.kind === 'wiki' || source.kind === 'memory') && source.content.trim()) {
                wiki.push({ name: source.name?.trim() || source.kind, content: source.content })
            }
        }
    }
    return { lorebook, wiki }
}

/** Called by the main send right before the request. Does nothing for chats nobody watches. */
export function captureChatContext(chatId: string | undefined, messages: { requestStatusSources?: RequestInjectionSource[] }[]): void {
    if (!chatId || !watched.has(chatId)) return
    captured.set(chatId, collectChatContext(messages))
}

/** The context of the last request since the previous take, then forgets it. */
export function takeChatContext(chatId: string): CapturedChatContext | undefined {
    const value = captured.get(chatId)
    captured.delete(chatId)
    return value
}
