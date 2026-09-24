import type { PainterChatData } from './types'

/** Rebind an already copied/imported chat; unfinished compression stays with its original owner. */
export function rebindPainterChatScope(chat: { id?: string; bardPainter?: PainterChatData }, characterId: string): void {
    const painter = chat.bardPainter
    if (!painter || !chat.id) return
    const results = Array.isArray(painter.results) ? painter.results : []
    const omittedIds = new Set(results.filter(result => result?.compressionPending).map(result => result.id))
    painter.results = results.filter(result => result && !result.compressionPending)
    const anchors = [painter.anchor, ...painter.results.map(result => result.anchor)]
    for (const anchor of anchors) {
        if (!anchor) continue
        anchor.characterId = characterId
        anchor.chatId = chat.id
    }
    if (painter.settings?.context && omittedIds.has(painter.settings.context.referenceId)) {
        painter.settings.context.referenceId = ''
    }
}
