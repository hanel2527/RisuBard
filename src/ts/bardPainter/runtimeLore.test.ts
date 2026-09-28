import { beforeEach, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'
import type { Database } from '../storage/database.svelte'
import { createPainterChatData } from './types'
import { createBardLoreSettings, upgradeLegacyLorebook } from '../lorebook/bardLore'

const mocks = vi.hoisted(() => ({ db: {} as Database, request: vi.fn(), save: vi.fn() }))
vi.mock('../stores.svelte', () => ({ DBState: { db: mocks.db }, selectedCharID: writable(0), selIdState: { selId: 0 }, ReloadChatPointer: writable(0) }))
vi.mock('../storage/database.svelte', () => ({ appVer: 'test', getCurrentCharacter: () => mocks.db.characters[0], getDatabase: () => mocks.db }))
vi.mock('../globalApi.svelte', () => ({ requestImmediateSave: mocks.save, globalFetch: vi.fn(), forageStorage: { createAuth: vi.fn() }, getFileSrc: async () => '', downloadFile: vi.fn() }))
vi.mock('../process/request/request', () => ({ requestChatData: mocks.request }))
vi.mock('../risubard/memoryWiki', () => ({ loadNarrativeMemoryWiki: vi.fn() }))
vi.mock('../storage/chatStorage', () => ({ ensureChatHydrated: vi.fn() }))
vi.mock('../process/files/inlays', () => ({ setInlayAsset: vi.fn(), getInlayAssetBlob: vi.fn(), getInlayInfosBatch: () => [] }))
vi.mock('../process/modules', () => ({ getModuleAssets: () => [], getModuleLorebooks: () => [], getModuleLorebooksWithSources: () => [], getModules: () => [] }))
vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (text: string) => text }))
vi.mock('../tokenizer', () => ({ tokenize: async (text: string) => text.length }))
vi.mock('../util', async (importOriginal) => ({ ...await importOriginal<typeof import('../util')>(), findCharacterbyId: vi.fn(), pickHashRand: () => 0 }))
vi.mock('src/lang', () => ({ language: {}, getCurrentLocale: () => 'en' }))
import { PainterSession } from './runtime.svelte'

function lore(id: string, key: string, content: string) {
    return { id, key, comment: id, content, mode: 'normal' as const, insertorder: 100, alwaysActive: false, secondkey: '', selective: false }
}

beforeEach(() => {
    vi.clearAllMocks()
    const data = createPainterChatData()
    Object.assign(data.settings.context, { characterLorebook: true, characterDescription: false, before: 0 })
    data.anchor = { characterId: 'bot', chatId: 'chat', messageId: 'm1', start: 0, end: 17, text: 'Aria in a garden.' }
    Object.assign(mocks.db, {
        characters: [{ type: 'character', chaId: 'bot', name: 'Story', chatPage: 1,
            globalLore: [lore('aria', 'Aria', 'silver hair, blue eyes'), lore('unrelated', 'Zelda', 'UNRELATED '.repeat(11_000))],
            loreSettings: { tokenBudget: 500, recursiveScanning: false, matchingMode: 'partial' },
            chats: [{ id: 'chat', localLore: [], message: [{ chatId: 'm1', role: 'char', data: 'Aria in a garden.' }, { chatId: 'future', role: 'char', data: 'Zelda' }], bardPainter: data },
                { id: 'other', localLore: [], message: [{ role: 'user', data: 'Zelda' }] }],
        }],
        loreBookToken: 500, loreBookDepth: 3, username: 'User',
    })
    mocks.request.mockResolvedValue({ type: 'success', result: JSON.stringify({ rendering: '', scene: 'garden', negative: '', subjects: [] }) })
    mocks.save.mockResolvedValue(undefined)
})

it.each(['legacy', 'bard'] as const)('retrieves scene lore in %s mode without sending unrelated large lore or reading the active chat', async (mode) => {
    const char = mocks.db.characters[0]
    const bard = upgradeLegacyLorebook(char.globalLore, () => 'unused', createBardLoreSettings({ contextMessages: 0, targetTokens: 500, maximumTokens: 500 }))
    bard.mode = mode
    char.bardLore = bard
    const original = JSON.stringify(char)
    const session = new PainterSession('bot', 'chat')
    expect(await session.prepare()).toBe(true)
    expect(session.state.error).toBe('')
    const payload = JSON.parse(mocks.request.mock.calls[0][0].formated[1].content)
    expect(payload.references).toContainEqual({ name: 'characterLorebook', content: expect.stringContaining('silver hair, blue eyes') })
    expect(JSON.stringify(payload.references)).not.toContain('UNRELATED')
    expect(char.chatPage).toBe(1)
    expect(JSON.stringify(char.globalLore)).toBe(JSON.stringify(JSON.parse(original).globalLore))
})

it.each(['legacy', 'bard'] as const)('resolves painter links from matched canonical lore in %s mode', async mode => {
    const char = mocks.db.characters[0]
    char.bardPainter = { identities: [{ id: 'preset-a', name: 'Portrait preset', aliases: [], appearance: 'silver hair' }], outfits: [] }
    char.globalLore[0].extentions = { risu_case_sensitive: false, risubard: { bardPainter: { identityId: 'preset-a' } } }
    char.globalLore[1].extentions = { risu_case_sensitive: false, risubard: { bardPainter: { identityId: 'absent' } } }
    char.bardLore = upgradeLegacyLorebook(char.globalLore, () => 'unused', createBardLoreSettings({ contextMessages: 0, targetTokens: 500, maximumTokens: 500 }))
    char.bardLore.mode = mode
    const session = new PainterSession('bot', 'chat')
    expect(await session.prepare()).toBe(true)
    const input = JSON.parse(mocks.request.mock.calls[0][0].formated[1].content)
    const source = input.references.find((item: any) => item.name === '로어에 연결된 캐릭터 프리셋')
    expect(JSON.parse(source.content)).toEqual([{ loreTitle: 'aria', loreKeys: 'Aria', identityId: 'preset-a' }])
})

it('searches selected surrounding messages and the current refinement instruction only', async () => {
    const char = mocks.db.characters[0]
    char.globalLore = [lore('aria', 'Aria', 'silver hair'), lore('bea', 'Beatrice', 'red hair'), lore('cora', 'Cora', 'green eyes'), lore('zelda', 'Zelda', 'EXCLUDED')]
    const chat = char.chats[0]
    chat.message.unshift({ chatId: 'previous', role: 'char', data: 'Beatrice walks in.' })
    chat.bardPainter.settings.context.before = 1
    const session = new PainterSession('bot', 'chat')
    expect(await session.prepare(undefined, { instruction: 'Include Cora' })).toBe(true)
    const refs = JSON.stringify(JSON.parse(mocks.request.mock.calls[0][0].formated[1].content).references)
    expect(refs).toContain('silver hair')
    expect(refs).toContain('red hair')
    expect(refs).toContain('green eyes')
    expect(refs).not.toContain('EXCLUDED')
})

it('uses Grimoire aliases and excludes entries marked never', async () => {
    const char = mocks.db.characters[0]
    char.globalLore = [lore('aria', 'Aria', 'silver hair'), lore('hidden', 'Moonlight', 'HIDDEN PROFILE')]
    char.bardLore = upgradeLegacyLorebook(char.globalLore, () => 'unused', createBardLoreSettings({ targetTokens: 500, maximumTokens: 500 }))
    char.bardLore.mode = 'bard'
    char.bardLore.metadata.find(item => item.sourceLegacyId === 'aria')!.aliases = ['Moonlight']
    char.bardLore.metadata.find(item => item.sourceLegacyId === 'hidden')!.activation = 'never'
    const session = new PainterSession('bot', 'chat')
    session.data.anchor!.text = 'Moonlight enters the garden.'
    expect(await session.prepare()).toBe(true)
    const refs = JSON.stringify(JSON.parse(mocks.request.mock.calls[0][0].formated[1].content).references)
    expect(refs).toContain('silver hair')
    expect(refs).not.toContain('HIDDEN PROFILE')
})

it('reports a Grimoire required-lore budget error without sending an unbounded fallback', async () => {
    const char = mocks.db.characters[0]
    char.globalLore = [lore('required', '', 'required text '.repeat(100))]
    char.bardLore = upgradeLegacyLorebook(char.globalLore, () => 'unused', createBardLoreSettings({ targetTokens: 500, maximumTokens: 500 }))
    char.bardLore.mode = 'bard'
    char.bardLore.metadata[0].activation = 'required'
    const session = new PainterSession('bot', 'chat')
    expect(await session.prepare()).toBe(false)
    expect(session.state.error).not.toBe('')
    expect(mocks.request).not.toHaveBeenCalled()
})

it('does not include character lore when the option is off or no entries match', async () => {
    const session = new PainterSession('bot', 'chat')
    session.data.settings.context.characterLorebook = false
    expect(await session.prepare()).toBe(true)
    session.data.settings.context.characterLorebook = true
    session.data.anchor!.text = 'An empty room.'
    expect(await session.prepare()).toBe(true)
    for (const call of mocks.request.mock.calls) {
        expect(JSON.parse(call[0].formated[1].content).references.some((source: { name: string }) => source.name === 'characterLorebook')).toBe(false)
    }
})
