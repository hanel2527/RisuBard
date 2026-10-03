import { beforeEach, expect, it, vi } from 'vitest'
import { outfitsForIdentity } from './library'
import type { Database } from '../storage/database.svelte'
import { createPainterChatData } from './types'

const mocks = vi.hoisted(() => ({ db: {} as Database, save: vi.fn(), request: vi.fn(), lore: vi.fn(), hydrate: vi.fn() }))
vi.mock('../stores.svelte', () => ({ DBState: { db: mocks.db }, ReloadChatPointer: { update: vi.fn() } }))
vi.mock('../globalApi.svelte', () => ({ requestImmediateSave: mocks.save, globalFetch: vi.fn(), forageStorage: { createAuth: vi.fn() } }))
vi.mock('../process/request/request', () => ({ requestChatData: mocks.request }))
vi.mock('../loreBuilder', () => ({ collectLoreBuilderSources: () => ({}), matchLoreBuilderCharacterLorebook: mocks.lore }))
vi.mock('../risubard/memoryWiki', () => ({ loadNarrativeMemoryWiki: vi.fn() }))
vi.mock('../process/files/inlays', () => ({ setInlayAsset: vi.fn(), getInlayAssetBlob: vi.fn() }))
vi.mock('../storage/chatStorage', () => ({ ensureChatHydrated: mocks.hydrate }))
vi.mock('./image', () => ({ compressPainterImage: vi.fn() }))
vi.mock('./gallery', () => ({ savePainterGalleryRecord: vi.fn() }))
import { PainterSession } from './runtime.svelte'

const identity = (id: string) => ({ id, name: id, aliases: [], appearance: `${id} hair` })
const lore = (id?: string) => ({ id, key: 'Aria', comment: 'Aria profile', content: 'silver hair', secondkey: '', insertorder: 100, alwaysActive: false, selective: false, mode: 'normal' as const })
let session: PainterSession
beforeEach(() => {
    vi.resetAllMocks()
    const data = createPainterChatData()
    data.anchor = { characterId: 'bot', chatId: 'chat', messageId: 'm', start: 0, end: 4, text: 'Aria' }
    data.draft = { scene: 'garden', rendering: '', negative: '', subjects: ['a', 'b'].map(id => ({ ...identity(id), kind: 'character', clothing: 'old coat', state: '', pose: '', negative: '' })) }
    Object.assign(mocks.db, { characters: [{ chaId: 'bot', chatPage: 0, globalLore: [lore('lore-a'), lore()],
        bardPainter: { identities: [identity('a'), identity('b')], outfits: [{ id: 'coat', subjectId: 'a', name: 'Coat', clothing: 'blue coat', state: '', attachToCard: true }] },
        chats: [{ id: 'chat', message: [{ chatId: 'm', data: 'Aria', role: 'char' }], bardPainter: data }] }], bardPainterLibrary: undefined, bardPainterSettings: undefined })
    mocks.save.mockResolvedValue(undefined)
    mocks.hydrate.mockImplementation(async (chats, i) => chats[i])
    mocks.lore.mockResolvedValue({ content: '', sources: [], entries: [] })
    mocks.request.mockResolvedValue({ type: 'success', result: JSON.stringify({ scene: 'garden', rendering: '', negative: '', subjects: [] }) })
    session = new PainterSession('bot', 'chat')
})

it('shares a legacy outfit without losing its original owner and applies it to another subject', async () => {
    expect(await session.setIdentityOutfits('b', ['coat'], 'coat')).toBe(true)
    expect(session.bot.outfits[0].subjectId).toBe('')
    expect(session.bot.identities[0].outfitIds).toContain('coat')
    expect(session.bot.identities[1]).toMatchObject({ outfitIds: ['coat'], defaultOutfitId: 'coat' })
    expect(await session.applyOutfit('b', 'coat')).toBe(true)
    expect(session.data.draft!.subjects[1].clothing).toBe('blue coat')
    expect(await session.removeIdentity('a')).toBe(true)
    expect(session.bot.outfits.map(item => item.id)).toContain('coat')
    expect(session.bot.identities[0].defaultOutfitId).toBe('coat')
})

it('unlinks a legacy owned outfit without deleting it, and cleans up deleted template defaults', async () => {
    expect(await session.setIdentityOutfits('a', [])).toBe(true)
    expect(session.bot.outfits[0].subjectId).toBe('')
    expect(session.bot.identities[0].outfitIds).toEqual([])
    await session.setIdentityOutfits('b', ['coat'], 'coat')
    expect(await session.removeOutfit('coat', true)).toBe(true)
    expect(session.bot.identities.every(item => !item.outfitIds?.includes('coat') && !item.defaultOutfitId)).toBe(true)
})

it('requires renewed card attachment consent and avoids duplicate names when converting legacy outfits', async () => {
    session.bot.outfits.push({ id: 'other-coat', subjectId: 'b', name: ' coat ', clothing: 'red coat', state: '', attachToCard: true })
    expect(await session.setIdentityOutfits('b', ['coat', 'other-coat'])).toBe(true)
    expect(session.bot.outfits.every(item => !item.attachToCard && !item.subjectId)).toBe(true)
    expect(new Set(session.bot.outfits.map(item => item.name.trim().toLocaleLowerCase())).size).toBe(2)
    const outfit = session.bot.outfits[1]
    expect(await session.saveOutfitPreset({ ...outfit, clothing: 'green coat' }, true)).toBe(outfit.id)
})

it('rolls back outfit conversion and both identity links when saving fails', async () => {
    const before = JSON.stringify(session.bot)
    mocks.save.mockRejectedValueOnce(new Error('disk full'))
    expect(await session.setIdentityOutfits('b', ['coat'], 'coat')).toBe(false)
    expect(JSON.stringify(session.bot)).toBe(before)
    expect(session.state.error).toContain('disk full')
})

it('copies a character and outfits to global and back with independent IDs and attachment flags', async () => {
    await session.setIdentityOutfits('a', ['coat'], 'coat')
    session.bot.identities[0].attachToCard = true
    const globalId = await session.copyIdentityToGlobal('a')
    expect(globalId).toBeTruthy()
    expect(globalId).not.toBe('a')
    const global = session.globalLibrary
    expect(global.identities[0].attachToCard).toBeUndefined()
    expect(global.outfits[0].attachToCard).toBeUndefined()
    expect(global.identities[0].defaultOutfitId).toBe(global.outfits[0].id)
    const importedId = await session.importGlobalIdentity(globalId!)
    const imported = session.bot.identities.find(item => item.id === importedId)!
    expect(imported.id).not.toBe(globalId)
    expect(imported.name).not.toBe('a')
    imported.appearance = 'changed'
    expect(global.identities[0].appearance).toBe('a hair')
    // Global outfits are referenced by the bot, not copied.
    expect(imported.defaultOutfitId).toBe(global.outfits[0].id)
    expect(session.bot.globalOutfits).toEqual([{ id: global.outfits[0].id }])
    expect(session.botCatalog.outfits.find(item => item.id === imported.defaultOutfitId)?.clothing).toBe('blue coat')
})

it('rolls back the first global creation and supports outfit-only copy/import', async () => {
    mocks.save.mockRejectedValueOnce(new Error('disk full'))
    expect(await session.copyIdentityToGlobal('a')).toBeUndefined()
    expect(mocks.db.bardPainterLibrary).toBeUndefined()
    const id = await session.copyOutfitToGlobal('coat', true)
    expect(session.globalLibrary.identities).toEqual([])
    expect(session.globalLibrary.outfits[0]).toMatchObject({ id, subjectId: '' })
    const imported = await session.importGlobalOutfit(id!)
    expect(session.bot.outfits.find(item => item.id === imported)?.subjectId).toBe('')
})

it('edits and removes global presets without modifying bot copies', async () => {
    const id = await session.copyIdentityToGlobal('a')
    const original = JSON.stringify(session.bot)
    const global = session.globalLibrary.identities[0]
    await session.saveIdentity({ ...global, appearance: 'green eyes' }, false, true)
    expect(session.globalLibrary.identities[0].appearance).toBe('green eyes')
    expect(await session.removeIdentity(id!, true)).toBe(true)
    expect(JSON.stringify(session.bot)).toBe(original)
    expect(session.globalLibrary.outfits).toHaveLength(1)
})

it('links lore via extensions without altering content, and unlinks when an identity is removed', async () => {
    const entry = session.character.globalLore[0]
    entry.extentions = { risu_case_sensitive: true, custom: { preserved: 1 } }
    const original = structuredClone(entry)
    expect(await session.setLoreIdentity('lore-a', 'a')).toBe(true)
    expect(session.character.globalLore[0]).toMatchObject(original)
    expect(session.loreEntries[0].identityId).toBe('a')
    expect(await session.setLoreIdentity('lore-a', 'missing')).toBe(false)
    expect(await session.removeIdentity('a')).toBe(true)
    expect(session.loreEntries[0].identityId).toBeUndefined()
    expect(session.character.globalLore[0].content).toBe(original.content)
    expect(session.character.globalLore[0].extentions?.custom).toEqual({ preserved: 1 })
})

it('keeps idless lore read-only until explicit linking and rejects stale selections', async () => {
    const entries = session.loreEntries
    expect(session.character.globalLore[1].id).toBeUndefined()
    mocks.save.mockRejectedValueOnce(new Error('disk full'))
    expect(await session.setLoreIdentity(entries[1].id, 'a')).toBe(false)
    expect(session.character.globalLore[1].id).toBeUndefined()
    expect(await session.setLoreIdentity(entries[1].id, 'a')).toBe(true)
    expect(session.character.globalLore[1].id).toBeTruthy()
    session.character.globalLore = [session.character.globalLore[0]]
    expect(await session.setLoreIdentity(entries[1].id, 'b')).toBe(false)
    expect(session.loreEntries[0].identityId).toBeUndefined()
})

it('fills a lore-linked preset with saved appearance and outfit text after the planner picks their ids', async () => {
    await session.setIdentityOutfits('b', ['coat'], 'coat')
    await session.setLoreIdentity('lore-a', 'b')
    session.data.settings.context.characterLorebook = true
    mocks.lore.mockResolvedValue({ content: 'Aria profile', sources: [], entries: [session.character.globalLore[0]] })
    mocks.request.mockResolvedValueOnce({ type: 'success', result: JSON.stringify({ scene: 'garden', rendering: '', negative: '', subjects: [
        { id: 'b', name: '그의 여동생', aliases: [], kind: 'character', appearance: '', clothing: '', outfitId: 'coat', state: 'wet', pose: 'standing', negative: '' },
    ] }) })
    expect(await session.prepare()).toBe(true)
    expect(session.data.draft!.subjects[0]).toMatchObject({ id: 'b', appearance: 'b hair', clothing: 'blue coat', state: 'wet', outfitId: 'coat', presetMatch: 'lore' })
})

it('uses only matched lore links and projects shared outfits for each linked character', async () => {
    await session.setIdentityOutfits('b', ['coat'], 'coat')
    await session.setLoreIdentity('lore-a', 'b')
    session.data.settings.context.characterLorebook = true
    mocks.lore.mockResolvedValue({ content: 'Aria profile', sources: [], entries: [session.character.globalLore[0]] })
    expect(await session.prepare()).toBe(true)
    const input = JSON.parse(mocks.request.mock.calls[0][0].formated[1].content)
    const link = input.references.find((item: any) => item.name === '로어에 연결된 캐릭터 프리셋')
    expect(JSON.parse(link.content)[0]).toMatchObject({ loreTitle: 'Aria profile', identityId: 'b' })
    expect(input.identities.filter((item: any) => item.outfits.some((outfit: any) => outfit.id === 'coat')).map((item: any) => item.id)).toEqual(['a', 'b'])
    expect(input.identities.find((item: any) => item.id === 'b').defaultOutfitId).toBe('coat')
    session.data.settings.context.characterLorebook = false
    expect(await session.prepare()).toBe(true)
    expect(JSON.parse(mocks.request.mock.lastCall![0].formated[1].content).references.some((item: any) => item.name === '로어에 연결된 캐릭터 프리셋')).toBe(false)
})

it('keeps character links to global outfits hidden while they are unselected for the bot', async () => {
    mocks.db.bardPainterLibrary = { identities: [], outfits: [{ id: 'dress', subjectId: '', name: 'Dress', clothing: 'white dress', state: '' }] }
    expect(await session.setBotGlobalOutfits(['dress'])).toBe(true)
    expect(await session.setIdentityOutfits('a', ['dress'], 'dress')).toBe(true)
    expect(await session.setBotGlobalOutfits([])).toBe(true)
    expect(session.botCatalog.outfits.some(item => item.id === 'dress')).toBe(false)
    expect(await session.setIdentityOutfits('a', [])).toBe(true)
    expect(session.bot.identities[0]).toMatchObject({ outfitIds: ['dress'], defaultOutfitId: 'dress' })
    expect(await session.saveIdentity({ ...session.bot.identities[0], appearance: 'changed' })).toBe('a')
    expect(await session.setBotGlobalOutfits(['dress'])).toBe(true)
    expect(outfitsForIdentity(session.botCatalog, 'a').map(item => item.id)).toEqual(['dress'])
    expect(await session.setGlobalOutfitAttachment('dress', true)).toBe(true)
    expect(session.bot.globalOutfits).toEqual([{ id: 'dress', attachToCard: true }])
})
