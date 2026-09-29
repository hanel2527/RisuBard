import { get } from 'svelte/store'
import { DBState, selectedCharID } from '../stores.svelte'
import { parseKeyValue } from '../util'
import type { Chat, character } from '../storage/database.svelte'

function getSelectedChat() {
    const selectedChar = get(selectedCharID)
    const char = DBState.db.characters[selectedChar]
    return char?.chats?.[char.chatPage]
}

export function getChatVar(key:string, character?:character, targetChat?:Chat): string {
    const selectedChar = get(selectedCharID)
    const char = character ?? DBState.db.characters[selectedChar]
    if(!char){
        return 'null'
    }
    const chat = targetChat ?? char.chats[char.chatPage]
    chat.scriptstate ??= {}
    const state = (chat.scriptstate['$' + key])
    if(state === undefined || state === null){
        const defaultVariables = parseKeyValue(char.defaultVariables).concat(parseKeyValue(DBState.db.templateDefaultVariables))
        const findResult = defaultVariables.find((f) => {
            return f[0] === key
        })
        if(findResult){
            return findResult[1]
        }
        return 'null'
    }
    return state.toString()
}

export function setChatVar(key:string, value:string, targetChat?:Chat): boolean {
    const selectedChar = get(selectedCharID)
    const chat = targetChat ?? DBState.db.characters[selectedChar].chats[DBState.db.characters[selectedChar].chatPage]
    chat.scriptstate ??= {}
    const stateKey = '$' + key
    if(chat.scriptstate[stateKey] === value){
        return false
    }
    chat.scriptstate[stateKey] = value
    return true
}

export function getGlobalChatVar(key:string, targetChat?:Chat): string {
    const chat = targetChat ?? getSelectedChat()
    if(
        !DBState.db.disableToggleBinding
        && chat?.useLocallySetGlobalVariables
        && chat.GLGlobalVariables
        && Object.hasOwn(chat.GLGlobalVariables, key)
    ){
        return chat.GLGlobalVariables[key]
    }
    return DBState.db.globalChatVariables[key] ?? 'null'
}

export function setGlobalChatVar(key:string, value:string): void {
    const chat = getSelectedChat()
    if(!DBState.db.disableToggleBinding && chat?.useLocallySetGlobalVariables){
        chat.GLGlobalVariables ??= {}
        chat.GLGlobalVariables[key] = value
        return
    }
    DBState.db.globalChatVariables[key] = value
}
