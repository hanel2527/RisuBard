import { describe, expect, it } from 'vitest'
import type { character, Chat } from '../storage/database.svelte'
import { captureGenerationTarget, createGenerationScope } from './generationTarget'

describe('generation target identity', () => {
    const fixture = () => {
        const a = { id:'A', message:[] } as Chat
        const b = { id:'B', message:[] } as Chat
        const char = { chaId:'bot', chatPage:0, chats:[a,b] } as character
        const characters = [char]
        return {a,b,char,characters,scope:createGenerationScope(()=>characters,captureGenerationTarget(char))}
    }
    it('resolves the same chat after switching, insertion and reorder', () => {
        const {char,scope,b} = fixture()
        char.chatPage = 1
        char.chats.reverse()
        char.chats.unshift({id:'C',message:[]} as Chat)
        scope.chat = {...scope.chat, note:'A result'}
        expect(scope.chat.id).toBe('A')
        expect(scope.chatIndex).toBe(2)
        expect(b).toEqual({id:'B',message:[]})
    })
    it('keeps delayed postprocessed output and variables in the captured chat after selection changes', async () => {
        const { char, scope, b } = fixture()
        const completed: Chat = {
            ...scope.chat,
            message: [{ role: 'char', data: 'Completed A', chatId: 'response-A' }],
            scriptstate: { turn: 1 },
        }
        const publication = Promise.resolve(completed).then(chat => { scope.chat = chat })
        char.chatPage = 1
        char.chats.reverse()
        await publication
        expect(scope.chat.id).toBe('A')
        expect(scope.chat.message).toEqual(completed.message)
        expect(scope.chat.scriptstate).toEqual({ turn: 1 })
        expect(char.chats.find(chat => chat.id === 'B')).toEqual(b)
    })
    it('rejects a missing target rather than writing to its former slot', () => {
        const {char,scope,b,a} = fixture()
        char.chats.shift()
        expect(()=>{scope.chat = a}).toThrow('identity mismatch')
        expect(char.chats).toEqual([b])
    })
    it('rejects duplicate and mismatched identities', () => {
        const {char,scope,b,a} = fixture()
        expect(()=>{scope.chat = b}).toThrow('identity mismatch')
        char.chats.push({...a})
        expect(()=>scope.chat).toThrow('identity mismatch')
    })
})
