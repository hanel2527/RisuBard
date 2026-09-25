import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'
import { painterInsertionRequest, painterSelection } from './selectionState'
import { createPainterChatData } from './types'
import { painterTestState } from '../../lib/Others/BardPainterTestState.svelte'

const mocks = vi.hoisted(() => ({ db: { characters: [] as any[] }, save: vi.fn(), asset: vi.fn(), remove: vi.fn(), reload: vi.fn(), pick: vi.fn() }))
vi.mock('../util', () => ({ selectFileByDom: mocks.pick }))
vi.mock('../stores.svelte', () => ({ DBState: { db: mocks.db }, ReloadChatPointer: { update: mocks.reload } }))
vi.mock('../globalApi.svelte', () => ({ requestImmediateSave: mocks.save }))
vi.mock('../process/files/inlays', () => ({ setInlayAsset: mocks.asset, removeInlayAsset: mocks.remove }))
import { createExternalImageInsertion, readExternalImage, chooseExternalImageForPlacement } from './externalImage'
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

beforeEach(() => {
    vi.resetAllMocks()
    painterInsertionRequest.set(null); painterSelection.set(null)
    mocks.save.mockResolvedValue(undefined); mocks.asset.mockResolvedValue(undefined)
})

function setup() {
    const source = 'First paragraph.\n\nLast paragraph.'
    const anchor = { characterId: 'bot', chatId: 'chat', messageId: 'm', start: 18, end: 33, text: 'Last paragraph.' }
    const painter = createPainterChatData(); painter.anchor = anchor
    const chat = painterTestState({ id: 'chat', message: [{ chatId: 'm', data: source, swipes: [source, 'alternative'], swipeId: 0 }], bardPainter: painter, isStreaming: false })
    mocks.db.characters = [{ chaId: 'bot', chats: [chat] }]
    const asset = { name: 'photo.png', ext: 'png', type: 'image' as const, data: new Blob(['png']), width: 100, height: 200 }
    const active = { value: true }
    const request = createExternalImageInsertion(asset, 'bot', 'chat', () => active.value)
    painterInsertionRequest.set(request)
    painterSelection.set({ characterId: 'bot', chatId: 'chat', anchor })
    const target = { ...anchor, end: anchor.start, text: '' }
    return { request, chat, source, target, active, asset }
}

test('defers asset writes until placement and stores explicit gallery ownership', async () => {
    const { request, chat, source, target, asset } = setup()
    expect(mocks.asset).not.toHaveBeenCalled()
    expect(await request.insert(target)).toBe(true)
    expect(mocks.asset).toHaveBeenCalledWith(request.resultId, asset, { charId: 'bot', chatId: 'chat' })
    expect(chat.message[0].data).toBe(source.slice(0, 18) + `\n\n{{inlay::${request.resultId}}}\n\n` + source.slice(18))
    expect(chat.message[0].swipes).toEqual([chat.message[0].data, 'alternative'])
    expect(chat.bardPainter.anchor!.start).toBeGreaterThan(18)
    expect(get(painterSelection)?.anchor?.start).toBe(chat.bardPainter.anchor!.start)
})

test('cancelled placement, changed scope and streaming never write an asset', async () => {
    const { request, target, chat } = setup()
    expect(await request.insert({ ...target, chatId: 'other' })).toBe(false)
    chat.isStreaming = true
    expect(await request.insert(target)).toBe(false)
    chat.isStreaming = false
    painterInsertionRequest.set(null)
    expect(await request.insert(target)).toBe(false)
    expect(mocks.asset).not.toHaveBeenCalled()
})

test('restores text, swipes and painter anchors after save failure and retries without duplicating the asset', async () => {
    const { request, target, chat, source } = setup()
    mocks.save.mockRejectedValueOnce(new Error('save failed'))
    expect(await request.insert(target)).toBe(false)
    expect(request.error?.()).toContain('save failed')
    expect(chat.message[0].data).toBe(source)
    expect(chat.message[0].swipes).toEqual([source, 'alternative'])
    expect(chat.bardPainter.anchor!.start).toBe(18)
    expect(get(painterSelection)?.anchor?.start).toBe(18)
    expect(await request.insert(target)).toBe(true)
    expect(mocks.asset).toHaveBeenCalledTimes(1)
    expect(chat.message[0].data.split('{{inlay::')).toHaveLength(2)
})

test('retains newer text edits and retries only persistence when a failed save left the image in the message', async () => {
    const { request, target, chat } = setup()
    mocks.save.mockImplementationOnce(async () => {
        chat.message[0].data += '\nNew text'
        chat.message[0].swipes[0] = chat.message[0].data
        throw new Error('save failed')
    })
    expect(await request.insert(target)).toBe(false)
    expect(chat.bardPainter.anchor!.start).toBeGreaterThan(18)
    expect(await request.insert({ ...target, start: 0, end: 0 })).toBe(true)
    expect(chat.message[0].data).toContain('New text')
    expect(chat.message[0].data.split('{{inlay::')).toHaveLength(2)
    expect(get(painterSelection)?.anchor?.start).toBe(chat.bardPainter.anchor!.start)
})

test('does not overwrite a different swipe edited while insertion persistence was pending', async () => {
    const { request, target, chat, source } = setup()
    mocks.save.mockImplementationOnce(async () => {
        chat.message[0].swipes[1] = 'New alternative'
        throw new Error('save failed')
    })
    expect(await request.insert(target)).toBe(false)
    expect(chat.message[0].data).toBe(source)
    expect(chat.message[0].swipes).toEqual([source, 'New alternative'])
})

test.each(['cancel', 'edit', 'stream'])('revalidates after asset storage when interrupted by %s', async (change) => {
    const { request, target, chat, source, active } = setup()
    mocks.asset.mockImplementation(async () => {
        if (change === 'cancel') active.value = false
        if (change === 'edit') chat.message[0].data = 'Changed while saving'
        if (change === 'stream') chat.isStreaming = true
    })
    expect(await request.insert(target)).toBe(false)
    expect(chat.message[0].data).toBe(change === 'edit' ? 'Changed while saving' : source)
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.remove).toHaveBeenCalledWith(request.resultId)
})

test('rejects non-image files before decoding', async () => {
    await expect(readExternalImage(new File(['text'], 'notes.txt', { type: 'text/plain' }))).rejects.toThrow()
})

function decoder(fails = false) {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal('Image', class {
        naturalWidth = 1024; naturalHeight = 2048
        onload: (() => void) | null = null; onerror: (() => void) | null = null
        set src(value: string) { if (value) queueMicrotask(() => fails ? this.onerror?.() : this.onload?.()) }
    })
}
test('decodes and keeps the original image file and its dimensions', async () => {
    decoder()
    const file = new File(['original'], 'Photo.PNG', { type: 'image/png' })
    const asset = await readExternalImage(file)
    expect(asset).toMatchObject({ data: file, ext: 'png', width: 1024, height: 2048 })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-image')
})
test('reports corrupt images and releases the object URL', async () => {
    decoder(true)
    await expect(readExternalImage(new File(['broken'], 'bad.png'))).rejects.toThrow('이미지를 읽을 수 없습니다')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-image')
})
test('picker cancellation and a chat switch while selecting leave placement inactive', async () => {
    mocks.pick.mockResolvedValueOnce(null).mockResolvedValueOnce([new File(['png'], 'picture.png')])
    expect(await chooseExternalImageForPlacement('bot', 'chat', () => true)).toBe(false)
    expect(await chooseExternalImageForPlacement('bot', 'chat', () => false)).toBe(false)
    expect(get(painterInsertionRequest)).toBeNull()
    expect(mocks.asset).not.toHaveBeenCalled()
})
test('the image picker activates placement without saving or inserting anything', async () => {
    decoder()
    mocks.pick.mockResolvedValue([new File(['png'], 'picture.png')])
    expect(await chooseExternalImageForPlacement('bot', 'chat', () => true)).toBe(true)
    expect(get(painterInsertionRequest)).toMatchObject({ characterId: 'bot', chatId: 'chat' })
    expect(mocks.asset).not.toHaveBeenCalled()
})
