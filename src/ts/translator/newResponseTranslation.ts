import { get } from 'svelte/store'
import { notifyError } from '../alert'
import { ParseMarkdown, risuChatParser } from '../parser/parser.svelte'
import type { character, Chat } from '../storage/database.svelte'
import { createSimpleCharacter, DBState, ReloadChatPointer, selectedCharID } from '../stores.svelte'
import { translateHTML } from './translator'

/** Called only by generation completion, never by mounting or revisiting a chat. */
export async function translateNewResponse(
    character: character,
    chat: Chat,
    messageId: string | undefined,
    signal: AbortSignal,
): Promise<void> {
    const db = DBState.db
    if (signal.aborted || character.autoTranslateNewResponses === false
        || !db.autoTranslate || !db.translator || db.translatorType !== 'llm' || !messageId) return

    const index = chat.message.findIndex(message => message.chatId === messageId)
    const message = chat.message[index]
    if (!message || message.role !== 'char' || message.isComment || !message.data.trim()) return

    try {
        const original = message.data
        const cbsConditions = { firstmsg: false, chatRole: message.role }
        const simpleCharacter = createSimpleCharacter(character)
        let text = risuChatParser(original, {
            chara: character, chat, chatID: index, rmVar: true, visualize: true, cbsConditions,
        })
        // Match ChatBody's cache key in all three formatting modes.
        if (!db.translateBeforeHTMLFormatting) {
            text = await ParseMarkdown(text, simpleCharacter,
                db.legacyTranslation ? 'notrim' : 'pretranslate', index, cbsConditions)
        }
        if (signal.aborted) return
        await translateHTML(text, false, simpleCharacter, index, false, {
            allowDuringGeneration: true,
            translatorNote: character.translatorNote ?? '',
            realChatId: chat.id,
            signal,
        })

        // A background completion must not redraw a different chat at this index.
        const selected = DBState.db.characters[get(selectedCharID)]
        const visibleChat = selected?.chats[selected.chatPage]
        if (selected?.chaId === character.chaId && visibleChat?.id === chat.id
            && visibleChat?.message[index]?.chatId === messageId
            && visibleChat.message[index].data === original) {
            ReloadChatPointer.update(value => ({ ...value, [index]: (value[index] ?? 0) + 1 }))
        }
    } catch (error) {
        // Translation must not turn a successful generation into a failed send or skip wiki work.
        notifyError(error instanceof Error ? error.message : String(error))
    }
}
