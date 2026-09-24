import { NodeStorage } from '../storage/nodeStorage'
import type { Chat } from '../storage/database.svelte'
import type { InlayExplorerItem } from '../process/files/inlays'
import type { PainterResult } from './types'
import { composePainterPrompts } from './prompt'
import { writable } from 'svelte/store'

export const painterGalleryRequested = writable<string | null>(null)

export const PAINTER_GALLERY_PREFIX = 'inlay_generation/'
export const PAINTER_GALLERY_DELETED_CHAT = '__deleted__'
export const PAINTER_GALLERY_UNASSIGNED = '__unassigned__'

export interface PainterGalleryRecord {
    version: 1
    chatName: string
    result: PainterResult
}

/** Generation records belong to the asset, so deleting a chat preserves them. */
export async function savePainterGalleryRecord(result: PainterResult, chatName: string): Promise<void> {
    const data: PainterGalleryRecord = { version: 1, chatName, result }
    await new NodeStorage().setItem(PAINTER_GALLERY_PREFIX + result.assetId, new TextEncoder().encode(JSON.stringify(data)))
}

export async function loadPainterGalleryRecord(assetId: string): Promise<PainterGalleryRecord | null> {
    const bytes = await new NodeStorage().getItem(PAINTER_GALLERY_PREFIX + assetId)
    if (!bytes?.length) return null
    try {
        const value = JSON.parse(new TextDecoder().decode(bytes))
        return value?.version === 1 && value.result?.assetId === assetId && value.result?.draft && value.result?.style
            ? value : null
    } catch { return null }
}

/** Only pass hydrated chats. This does not load unrelated conversations. */
export async function preservePainterChatGallery(chat: Pick<Chat, 'name' | 'bardPainter'>): Promise<void> {
    await preservePainterChatsGallery([chat])
}

export async function preservePainterChatsGallery(chats: Array<Pick<Chat, 'name' | 'bardPainter'>>): Promise<void> {
    if (!chats.some(chat => chat.bardPainter?.results?.length)) return
    const storage = new NodeStorage()
    // List lightweight keys once, rather than downloading every saved prompt on each gallery visit.
    const [records, images] = await Promise.all([storage.keys(PAINTER_GALLERY_PREFIX), storage.keys('inlay/')])
    const saved = new Set(records), assets = new Set(images)
    for (const chat of chats) for (const result of chat.bardPainter?.results ?? []) {
        const key = PAINTER_GALLERY_PREFIX + result.assetId
        if (!saved.has(key) && assets.has('inlay/' + result.assetId)) {
            await savePainterGalleryRecord(result, chat.name ?? '')
            saved.add(key)
        }
    }
}

export function painterGalleryChatGroup(item: InlayExplorerItem, chatIds: ReadonlySet<string>): string {
    const id = item.meta?.chatId
    return !id ? PAINTER_GALLERY_UNASSIGNED : chatIds.has(id) ? id : PAINTER_GALLERY_DELETED_CHAT
}

export function filterPainterGallery(items: InlayExplorerItem[], characterId: string, chats: { id?: string }[], chatFilter = '', oldestFirst = false): InlayExplorerItem[] {
    const ids = new Set(chats.flatMap(chat => chat.id ? [chat.id] : []))
    return items.filter(item => item.type === 'image' && item.meta?.charId === characterId
        && (!chatFilter || painterGalleryChatGroup(item, ids) === chatFilter))
        .sort((a, b) => ((a.meta?.createdAt ?? 0) - (b.meta?.createdAt ?? 0)) * (oldestFirst ? 1 : -1) || a.id.localeCompare(b.id))
}

export interface GalleryPromptBlock { title: string; text: string }
export interface GalleryGenerationInfo { blocks: GalleryPromptBlock[]; settings: Array<[string, string]> }

export function painterGalleryInfo(record: PainterGalleryRecord): GalleryGenerationInfo {
    const { result } = record
    const prompts = composePainterPrompts(result.draft, result.style)
    return {
        blocks: [
            { title: '메인 프롬프트', text: prompts.positive },
            ...prompts.characters.flatMap((subject, index) => [
                { title: result.draft.subjects[index]?.name || `인물 ${index + 1}`, text: subject.prompt },
                ...(subject.negative ? [{ title: `${result.draft.subjects[index]?.name || `인물 ${index + 1}`} 제외 프롬프트`, text: subject.negative }] : []),
            ]),
            { title: '제외 프롬프트', text: prompts.negative },
        ].filter(block => block.text),
        settings: [
            ['모델', result.settings.model], ['크기', `${result.settings.width} × ${result.settings.height}`],
            ['시드', String(result.seed)], ['스텝', String(result.style.steps)], ['가이던스', String(result.style.scale)],
            ['샘플러', result.style.sampler], ['화풍', result.style.name],
        ],
    }
}

/** Normalize both NovelAI PNG Comment and RisuBard's WebP request envelope. */
export function novelAiGalleryInfo(metadata: Record<string, unknown>): GalleryGenerationInfo | null {
    let value: any = metadata
    if (typeof value.Comment === 'string') {
        try { value = { ...metadata, ...JSON.parse(value.Comment) } } catch { return null }
    }
    const params = value.parameters ?? value
    const caption = params.v4_prompt?.caption
    const negative = params.v4_negative_prompt?.caption
    const base = caption?.base_caption ?? params.prompt ?? value.input ?? value.Description
    if (typeof base !== 'string') return null
    const blocks: GalleryPromptBlock[] = [{ title: '메인 프롬프트', text: base }]
    const chars = caption?.char_captions ?? params.characterPrompts ?? []
    if (Array.isArray(chars)) chars.forEach((item, index) => {
        const text = item?.char_caption ?? item?.prompt
        if (typeof text === 'string' && text) blocks.push({ title: `인물 ${index + 1}`, text })
        const excluded = negative?.char_captions?.[index]?.char_caption ?? item?.uc
        if (typeof excluded === 'string' && excluded) blocks.push({ title: `인물 ${index + 1} 제외 프롬프트`, text: excluded })
    })
    const excluded = negative?.base_caption ?? params.negative_prompt ?? params.uc
    if (typeof excluded === 'string' && excluded) blocks.push({ title: '제외 프롬프트', text: excluded })
    const fields = [
        ['모델', value.model ?? value.Source], ['시드', params.seed], ['스텝', params.steps],
        ['가이던스', params.scale], ['샘플러', params.sampler], ['생성 시간', value['Generation time'] ?? value.Generation_time],
    ]
    return { blocks, settings: fields.filter((pair) => pair[1] !== undefined && pair[1] !== null).map(([label, data]) => [String(label), String(data)]) }
}
