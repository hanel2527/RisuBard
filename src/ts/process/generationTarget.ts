import { v4 } from 'uuid'
import type { character, Chat } from '../storage/database.svelte'

export type GenerationTarget = Readonly<{ characterId: string; chatId: string }>

export function captureGenerationTarget(character: character): GenerationTarget {
    const chat = character?.chats[character.chatPage]
    if (!character?.chaId || !chat) throw new Error('Generation chat is unavailable')
    chat.id ??= v4()
    return { characterId: character.chaId, chatId: chat.id }
}

export function resolveGenerationTarget(characters: character[], target: GenerationTarget) {
    const owners = characters.filter(c => c.chaId === target.characterId)
    if (owners.length !== 1) throw new Error('Generation character identity mismatch')
    const character = owners[0]
    const matches = character.chats.filter(c => c.id === target.chatId)
    if (matches.length !== 1) throw new Error('Generation chat identity mismatch')
    const chat = matches[0]
    return { character, chat, characterIndex: characters.indexOf(character), chatIndex: character.chats.indexOf(chat) }
}

// Resolve on each access: switching, insertion and reordering never retarget a write.
export function createGenerationScope(characters: () => character[], target: GenerationTarget) {
    return {
        get character() { return resolveGenerationTarget(characters(), target).character },
        get chat() { return resolveGenerationTarget(characters(), target).chat },
        set chat(chat: Chat) {
            if (chat.id !== target.chatId) throw new Error('Generation result identity mismatch')
            const resolved = resolveGenerationTarget(characters(), target)
            resolved.character.chats[resolved.chatIndex] = chat
        },
        get characterIndex() { return resolveGenerationTarget(characters(), target).characterIndex },
        get chatIndex() { return resolveGenerationTarget(characters(), target).chatIndex },
    }
}
