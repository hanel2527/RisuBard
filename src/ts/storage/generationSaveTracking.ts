import type { character } from './database.svelte'
import { deepTouch } from '../gui/deepTouch.svelte'

/** Called inside the save effect so streaming writes outside the visible chat are observed. */
export function createGenerationSaveTracker() {
    let previous = new Set<string>()
    return (characters: character[], generatingIds: Iterable<string>) => {
        const current = new Set(generatingIds)
        // Ending a generation can batch with its last chunk. Track it once more.
        const ids = new Set([...previous, ...current])
        previous = current
        const targets: {character: character; chat: character['chats'][number]; chatIndex: number}[] = []
        for (const character of characters) {
            character.chats.forEach((chat, chatIndex) => {
                if (!chat.id || !ids.has(chat.id) || chat._placeholder) return
                deepTouch(chat)
                targets.push({character, chat, chatIndex})
            })
        }
        return targets
    }
}
