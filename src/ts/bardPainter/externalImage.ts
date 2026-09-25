import { v4 } from 'uuid'
import { get } from 'svelte/store'
import { DBState, ReloadChatPointer } from '../stores.svelte'
import { requestImmediateSave } from '../globalApi.svelte'
import { setInlayAsset, removeInlayAsset, type InlayAsset } from '../process/files/inlays'
import { painterInsertionRequest, painterSelection, type PainterInsertionRequest } from './selectionState'
import { insertPainterReference, shiftPainterAnchor } from './selection'
import type { PainterAnchor } from './types'
import { selectFileByDom } from '../util'
import type { Chat, Message } from '../storage/database.svelte'

// Match the gallery thumbnail formats supported by the asset server.
export const EXTERNAL_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif']

export async function chooseExternalImageForPlacement(characterId: string, chatId: string, isCurrent: () => boolean): Promise<boolean> {
    const files = await selectFileByDom(EXTERNAL_IMAGE_EXTENSIONS, 'single')
    if (!files?.length || !isCurrent()) return false
    const asset = await readExternalImage(files[0])
    if (!isCurrent()) return false
    painterInsertionRequest.set(createExternalImageInsertion(asset, characterId, chatId, isCurrent))
    return true
}

/** Validate decoding without re-encoding: preserve original resolution and embedded metadata. */
export async function readExternalImage(file: File): Promise<InlayAsset> {
    const ext = file.name.split('.').at(-1)?.toLowerCase() ?? ''
    if (!file.size || !EXTERNAL_IMAGE_EXTENSIONS.includes(ext)) throw new Error('PNG, JPG, WebP 또는 GIF 이미지를 선택해 주세요.')
    const image = new Image()
    const url = URL.createObjectURL(file)
    try {
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve()
            image.onerror = () => reject(new Error('이미지를 읽을 수 없습니다. 파일이 손상되지 않았는지 확인해 주세요.'))
            image.src = url
        })
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('이미지 크기를 확인할 수 없습니다.')
        return { name: file.name, ext, type: 'image', data: file, width: image.naturalWidth, height: image.naturalHeight }
    } finally {
        image.onload = null; image.onerror = null; image.src = ''
        URL.revokeObjectURL(url)
    }
}

/** A selected file stays in memory until the user confirms a paragraph position. */
export function createExternalImageInsertion(asset: InlayAsset, characterId: string, chatId: string, isCurrent: () => boolean): PainterInsertionRequest {
    const assetId = v4()
    let saving = false, stored = false, error = '', completed = false
    let pendingSave: { chat: Chat; message: Message } | undefined
    const refresh = (chat: Chat, message: Message) => {
        const index = chat.message.indexOf(message)
        if (index >= 0) ReloadChatPointer.update(value => { value[index] = (value[index] ?? 0) + 1; return value })
    }
    const request: PainterInsertionRequest = {
        characterId, chatId, resultId: assetId, error: () => error,
        insert: async (anchor: PainterAnchor) => {
            if (saving || completed) return false
            saving = true; error = ''
            let writingAsset = false, attemptedSave = false
            try {
                const resolveTarget = () => {
                    if (!isCurrent() || get(painterInsertionRequest) !== request || anchor.characterId !== characterId || anchor.chatId !== chatId) throw new Error('채팅이 변경되었거나 이미지 삽입이 취소되었습니다.')
                    const chat = DBState.db.characters.find(char => char.chaId === characterId)?.chats.find(chat => chat.id === chatId)
                    if (!chat || chat._placeholder || !Array.isArray(chat.message)) throw new Error('채팅을 먼저 열어 주세요.')
                    if (chat.isStreaming || chat.risuBardWikiReboot) throw new Error('진행 중인 작업이 끝난 뒤 삽입해 주세요.')
                    const message = chat.message.find(message => message.chatId === anchor.messageId)
                    if (!message) throw new Error('삽입할 메시지가 삭제되었습니다.')
                    return { chat, message }
                }
                const { chat, message } = resolveTarget()
                if (pendingSave && pendingSave.chat === chat && chat.message.includes(pendingSave.message)
                    && [pendingSave.message.data, ...(pendingSave.message.swipes ?? [])].some(text => text.includes(`{{inlay::${assetId}}}`))) {
                    attemptedSave = true
                    await requestImmediateSave({ flushServer: true, rejectOnFailure: true })
                    completed = true
                    refresh(chat, pendingSave.message)
                    pendingSave = undefined
                    return true
                }
                pendingSave = undefined
                const source = message.data, swipeId = message.swipeId
                if (anchor.insertionUnavailable) throw new Error('삽입 위치를 다시 선택해 주세요.')
                const inserted = insertPainterReference(source, anchor, assetId, 'after')
                if (!stored) {
                    writingAsset = true
                    await setInlayAsset(assetId, asset, { charId: characterId, chatId })
                    stored = true
                }
                const current = resolveTarget()
                if (current.chat !== chat || current.message !== message || message.data !== source || message.swipeId !== swipeId) throw new Error('메시지가 변경되었습니다. 삽입 위치를 다시 선택해 주세요.')
                const swipes = message.swipes ? [...message.swipes] : undefined
                const selection = get(painterSelection)
                const shifted: Array<{ owner: { anchor?: PainterAnchor }; previous: PainterAnchor; next: PainterAnchor }> = []
                for (const owner of [chat.bardPainter, ...(chat.bardPainter?.results ?? [])]) {
                    if (owner?.anchor?.messageId !== anchor.messageId) continue
                    const previous = owner.anchor
                    owner.anchor = shiftPainterAnchor(previous, inserted.position, inserted.length)
                    shifted.push({ owner, previous, next: owner.anchor })
                }
                message.data = inserted.text
                if (message.swipes && swipeId !== undefined) message.swipes[swipeId] = inserted.text
                const shiftSelection = () => painterSelection.update(value => value === selection && value?.anchor?.characterId === characterId && value.anchor.chatId === chatId && value.anchor.messageId === anchor.messageId
                    ? { ...value, anchor: shiftPainterAnchor(value.anchor, inserted.position, inserted.length) } : value)
                attemptedSave = true
                try { await requestImmediateSave({ flushServer: true, rejectOnFailure: true }) }
                catch (cause) {
                    // Preserve newer edits if the user edited again while persistence was pending.
                    if (message.data === inserted.text) {
                        message.data = source
                    }
                    if (message.swipes && swipeId !== undefined && message.swipes[swipeId] === inserted.text) {
                        if (swipes && swipeId < swipes.length) message.swipes[swipeId] = swipes[swipeId]
                        else message.swipes.splice(swipeId, 1)
                    }
                    const retained = [message.data, ...(message.swipes ?? [])].some(text => text.includes(`{{inlay::${assetId}}}`))
                    if (retained) {
                        pendingSave = { chat, message }
                        shiftSelection()
                    } else {
                        for (const { owner, previous, next } of shifted) if (owner.anchor === next) owner.anchor = previous
                    }
                    throw cause
                }
                completed = true
                refresh(chat, message)
                shiftSelection()
                return true
            } catch (cause) {
                error = cause instanceof Error ? cause.message : String(cause)
                if (pendingSave) error += ' 이미지가 본문에 남아 있습니다. 다시 클릭하면 중복 삽입 없이 저장만 재시도합니다.'
                // Once a chat save has been attempted, retain the asset for retry/recovery.
                if (writingAsset && !attemptedSave) {
                    try { await removeInlayAsset(assetId); stored = false }
                    catch { error += ' 저장한 이미지 파일을 정리하지 못했습니다.' }
                }
                return false
            } finally { saving = false }
        },
    }
    return request
}
