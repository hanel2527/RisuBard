import { beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import type { character, Chat } from './storage/database.svelte'
import { createPainterChatData } from './bardPainter/types'
import { exportCharacterPackage, importPackageToCharacter, scanCharacterInlayIds } from './characterPackage'

const state = vi.hoisted(() => ({
    db: { characters: [] as any[], personas: [] },
    file: null as null | { name: string; data: Uint8Array },
    files: new Map<string, Uint8Array>(),
    assets: new Map<string, any>(),
    metas: new Map<string, any>(),
    errors: [] as unknown[],
}))

vi.mock('./alert', () => ({
    alertConfirm: async () => true, alertError: (error: unknown) => state.errors.push(error),
    alertStore: { set() {} }, alertWait() {}, notifySuccess() {},
}))
vi.mock('./characterCards', () => ({ exportCharacterCard() {}, importCharacterProcess() {} }))
vi.mock('./globalApi.svelte', () => ({
    LocalWriter: class { async init() { return true } }, VirtualWriter: class {},
    readImage() {}, checkCharOrder() {},
}))
vi.mock('./storage/database.svelte', () => ({
    getDatabase: () => state.db, setDatabase: (db: typeof state.db) => { state.db = db }, saveImage() {},
    normalizeChat: (chat: Chat) => chat,
}))
vi.mock('./storage/chatStorage', () => ({ fetchChatFromServer() {} }))
vi.mock('./util', () => ({ selectSingleFile: async () => state.file }))
vi.mock('./characters', () => ({ createBlankChar() {} }))
vi.mock('./process/processzip', () => ({
    CharXWriter: class {
        async write(name: string, data: string | Uint8Array) { state.files.set(name, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)) }
        async end() {}
    },
}))
vi.mock('./process/files/inlays', () => ({
    getInlayAsset: async (id: string) => state.assets.get(id) ?? null,
    getInlayInfosBatch: async (ids: string[]) => Object.fromEntries(ids.filter(id => state.assets.has(id)).map(id => [id, state.assets.get(id)])),
    setInlayAsset: async (id: string, asset: unknown, owner: unknown) => { state.assets.set(id, asset); if (owner) state.metas.set(id, owner) },
    reencodeImage() {},
}))
vi.mock('./process/files/inlayMeta', () => ({
    getInlayMeta: async (id: string) => state.metas.get(id) ?? null,
    setInlayMeta: async (id: string, meta: unknown) => { state.metas.set(id, meta) },
}))
vi.mock('./pngChunk', () => ({ PngChunk: {} }))
vi.mock('./personaScopes', () => ({ resolvePersonaById() {} }))
vi.mock('./risubard/gallery', () => ({ getCharacterGalleryForExport: () => undefined, stripGalleryFromChats: (chats: Chat[]) => chats }))

function painterChat() {
    const painter = createPainterChatData()
    const anchor = { characterId: 'source-bot', chatId: 'source-chat', messageId: 'source-message', start: 0, end: 5, text: 'hello' }
    painter.anchor = { ...anchor }
    painter.results = [{ id: 'result', assetId: 'painter-image', anchor: { ...anchor }, createdAt: 1 }] as typeof painter.results
    return { id: 'source-chat', name: 'Story', message: [{ chatId: 'source-message', role: 'char', data: 'hello world' }], bardPainter: painter } as Chat
}

function packageFile(chat: Chat, includeInlays = true) {
    const manifest = {
        type: 'risuCharacterPackage', version: 1, createdAt: '', character: { name: 'Target', file: '', isEmpty: true },
        chats: { count: 1, file: 'chats/chats.json' },
        ...(includeInlays ? { inlays: { count: 1, metaFile: 'inlays/meta.json', files: ['inlays/painter-image.webp'] } } : {}),
    }
    const entries: Record<string, Uint8Array> = {
        'manifest.json': strToU8(JSON.stringify(manifest)),
        'chats/chats.json': strToU8(JSON.stringify({ type: 'risuAllChats', ver: 2, data: [chat], folders: [] })),
    }
    if (includeInlays) {
        entries['inlays/painter-image.webp'] = new Uint8Array([82, 73, 70, 70, 1, 2, 3])
        entries['inlays/meta.json'] = strToU8(JSON.stringify({ 'painter-image': { ext: 'webp', type: 'image', createdAt: 10, updatedAt: 20, charId: 'source-bot', chatId: 'source-chat' } }))
    }
    return { name: 'story.zip', data: zipSync(entries) }
}

describe('BardPainter character packages', () => {
    beforeEach(() => {
        state.db = { characters: [{ chaId: 'target-bot', name: 'Target', chats: [], chatFolders: [] }], personas: [] }
        state.file = null
        state.files.clear(); state.assets.clear(); state.metas.clear(); state.errors.length = 0
    })

    it('exports uninserted painter assets and their existing binary metadata', async () => {
        state.db.characters[0].chats = [painterChat()]
        state.assets.set('painter-image', { data: 'data:image/webp;base64,UklGRgECAw==', ext: 'webp', type: 'image', name: 'Painting' })
        await exportCharacterPackage(0, { includeCharacter: false, includeChats: true, includeGallery: false, includePersona: false, includeInlays: true })
        expect(state.errors).toEqual([])
        expect(state.files.get('inlays/painter-image.webp')).toEqual(new Uint8Array([82, 73, 70, 70, 1, 2, 3]))
        expect(JSON.parse(new TextDecoder().decode(state.files.get('manifest.json'))).inlays.files).toEqual(['inlays/painter-image.webp'])
    })

    it('finds painter assets even when a chat has no loaded message array', () => {
        const chat = painterChat()
        delete chat.message
        expect([...scanCharacterInlayIds({ chats: [chat] } as character)]).toEqual(['painter-image'])
    })

    it('imports a private copy with destination anchors, token IDs, source offsets, and asset ownership', async () => {
        const chat = painterChat()
        const oldToken = '{{inlay::painter-image}}'
        chat.message[0].data = `${oldToken} hello world`
        chat.message[0].swipes = [chat.message[0].data]
        chat.bardPainter!.anchor!.start = oldToken.length + 1
        chat.bardPainter!.anchor!.end = oldToken.length + 6
        Object.assign(chat.bardPainter!.results[0].anchor, chat.bardPainter!.anchor)
        state.assets.set('painter-image', { data: 'existing-image', ext: 'webp' })
        state.file = packageFile(chat)
        await importPackageToCharacter(0)
        expect(state.errors).toEqual([])
        const imported = state.db.characters[0].chats[0] as Chat
        const result = imported.bardPainter!.results[0]
        expect(result.assetId).not.toBe('painter-image')
        expect(result.anchor).toMatchObject({ characterId: 'target-bot', chatId: imported.id, messageId: 'source-message' })
        expect(imported.bardPainter!.anchor).toMatchObject(result.anchor)
        expect(imported.message[0].data).toBe(`{{inlay::${result.assetId}}} hello world`)
        expect(imported.message[0].swipes[0]).toBe(imported.message[0].data)
        expect(imported.message[0].data.slice(result.anchor.start, result.anchor.end)).toBe('hello')
        expect(new Uint8Array(await state.assets.get(result.assetId).data.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70, 1, 2, 3]))
        expect(state.assets.get('painter-image').data).toBe('existing-image')
        expect(state.metas.get(result.assetId)).toMatchObject({ charId: 'target-bot', chatId: imported.id, createdAt: 10 })
    })

    it('keeps existing asset references when the package intentionally excludes inlay images', async () => {
        state.file = packageFile(painterChat(), false)
        await importPackageToCharacter(0)
        expect(state.errors).toEqual([])
        const imported = state.db.characters[0].chats[0] as Chat
        expect(imported.bardPainter!.results[0].assetId).toBe('painter-image')
        expect(imported.bardPainter!.results[0].anchor.chatId).toBe(imported.id)
    })
})
