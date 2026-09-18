import { describe, expect, test, vi } from 'vitest'
import type { Chat } from '../storage/database.svelte'
import { buildWikiContinuationChat, publishWikiContinuation, importWikiPackage } from './wikiTransfer'
import { createWikiPackage } from './wikiTransferPackage'

const source = (): Chat => ({ id: 'old', name: '이야기', message: [{ role: 'char', data: '과거', chatId: 'm1', risubardMemoryConfirmed: true }], note: '지침', localLore: [], scriptstate: { gold: 10 }, modules: ['module'], bookmarks: ['m1'], hypaV3Data: {} as Chat['hypaV3Data'], risuBardLastAutosaveTurn: 40, firstMessageDisabled: false })
describe('wiki transfer client', () => {
    test('builds an empty continuation keeping bindings and state without stale history or greeting', () => {
        const old = source()
        const chat = buildWikiContinuationChat(old, 'new')
        expect(chat).toMatchObject({ id: 'new', message: [], note: '지침', modules: ['module'], scriptstate: { gold: 10 }, firstMessageDisabled: true })
        expect(chat).not.toHaveProperty('bookmarks')
        expect(chat).not.toHaveProperty('hypaV3Data')
        expect(chat).not.toHaveProperty('risuBardLastAutosaveTurn')
        chat.scriptstate!.gold = 20
        expect(old.scriptstate!.gold).toBe(10)
        expect(old.message).toHaveLength(1)
    })
    test('rolls back the chat list and discards staged wiki when chat persistence fails', async () => {
        const old = source(), chat = buildWikiContinuationChat(old, 'new')
        const character = { chats: [old], chatPage: 0 }
        const complete = vi.fn(async () => {})
        const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
        await expect(publishWikiContinuation(character, chat, { inherit: async () => 'token', complete, save })).rejects.toThrow('disk full')
        expect(character.chats).toEqual([old])
        expect(character.chatPage).toBe(0)
        expect(complete).toHaveBeenCalledWith('token', 'discard')
        expect(save).toHaveBeenCalledTimes(2)
    })
    test('keeps saved chat if finalization fails and retries finalization without discarding it', async () => {
        const old = source(), chat = buildWikiContinuationChat(old, 'new')
        const character = { chats: [old], chatPage: 0 }
        const complete = vi.fn().mockRejectedValue(new Error('offline'))
        await expect(publishWikiContinuation(character, chat, { inherit: async () => 'token', complete, save: async () => {} })).rejects.toThrow('저장')
        expect(character.chats).toContain(chat)
        expect(complete.mock.calls.every(([, action]) => action === 'finalize')).toBe(true)
    })
    test('validates and authenticates package imports and reports server conflict detail', async () => {
        const pack = createWikiPackage([{ id: 'alice', title: '앨리스', type: 'character', content: '## 앨리스\n\n본문' }], ['alice'])
        const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: '앨리스 충돌' }), { status: 409 }))
        await expect(importWikiPackage({ characterId: 'char', chatId: 'chat', package: pack, fetchImpl, createAuth: async () => 'auth' })).rejects.toThrow('앨리스 충돌')
        expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ 'risu-auth': 'auth' })
    })
})
