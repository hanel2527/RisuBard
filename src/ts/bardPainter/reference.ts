import { getInlayMeta } from '../process/files/inlayMeta'
import { getInlayAssetBlob } from '../process/files/inlays'
import { loadPainterGalleryRecord, novelAiGalleryInfo } from './gallery'
import { readPainterImageMetadata } from './metadata'

/** Read one chosen image only. The owning bot boundary also applies to deleted chats. */
export async function loadPainterReference(assetId: string, characterId: string): Promise<string | null> {
    if (!assetId || !characterId) return null
    const owner = await getInlayMeta(assetId)
    if (!owner || owner.charId !== characterId) return null
    const saved = await loadPainterGalleryRecord(assetId)
    if (saved) {
        const characters = (saved.result.draft.subjects ?? []).flatMap(subject => {
            // Directly edited blocks are authoritative; never resurrect superseded structured tags.
            const prompt = typeof subject.prompt === 'string'
                ? subject.prompt.split(/\r?\n[ \t]*\r?\n/).slice(0, 2).join('\n\n').trim()
                : [subject.appearance, subject.clothing].filter(Boolean).join('\n\n').trim()
            return prompt ? [{ name: subject.name, prompt }] : []
        })
        if (characters.length) return JSON.stringify({ characters })
        const scene = saved.result.draft.scene?.trim()
        if (scene) return JSON.stringify({ prompt: scene })
    }
    const asset = await getInlayAssetBlob(assetId)
    if (!asset || asset.type !== 'image') return null
    const info = novelAiGalleryInfo(readPainterImageMetadata(new Uint8Array(await asset.data.arrayBuffer())))
    if (!info) return null
    const subjects = info.blocks.filter(block => /^인물 \d+$/.test(block.title) && block.text.trim())
    const useful = subjects.length ? subjects : info.blocks.filter(block => block.title === '메인 프롬프트' && block.text.trim())
    return useful.length ? JSON.stringify({ prompts: useful.map(block => ({ name: block.title, prompt: block.text })) }) : null
}
