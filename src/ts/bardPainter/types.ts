export interface PainterAnchor {
    characterId: string
    chatId: string
    messageId: string
    start: number
    end: number
    text: string
    /** Display-only selection: generation works, but no verified source insertion offsets exist. */
    insertionUnavailable?: boolean
}

export interface PainterSubject {
    id: string
    name: string
    aliases: string[]
    kind: 'character' | 'object'
    appearance: string
    clothing: string
    state: string
    pose: string
    negative: string
    locked?: boolean
    /** Outfit preset whose saved text fills clothing and state. */
    outfitId?: string
    /** Why the subject was linked to a saved character preset. */
    presetMatch?: 'lore' | 'name' | 'context'
    /** Verbatim text edited in the single character prompt block. */
    prompt?: string
}

export interface PainterFragment {
    id: string
    name: string
    prompt: string
}

export interface PainterDraft {
    rendering: string
    scene: string
    negative: string
    subjects: PainterSubject[]
    /** Planner-chosen PAINTER_IMAGE_SIZES id, used only while the size mode is 'ai'. */
    size?: string
    /** User-owned copies; never populated from model output. */
    fragments?: PainterFragment[]
}

export interface PainterStyle {
    id: string
    name: string
    artist: string
    rendering: string
    negative: string
    steps: number
    scale: number
    cfgRescale: number
    sampler: string
}

export interface PainterContext {
    before: number
    after: number
    surrounding: boolean
    systemPrompt: boolean
    characterDescription: boolean
    persona: boolean
    characterLorebook: boolean
    moduleLorebook: boolean
    wikiIds: string[]
    referenceId: string
    referenceAssetId?: string
}

export const PAINTER_IMAGE_MODELS = [
    'nai-diffusion-5-full', 'nai-diffusion-5-curated',
    'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated',
] as const

export function painterSubjectLimit(model: PainterSettings['model']): number {
    return model === 'nai-diffusion-4-5-full' || model === 'nai-diffusion-4-5-curated' ? 6 : 22
}

/** NovelAI canvases of about one megapixel; ids are what the planner returns. */
export const PAINTER_IMAGE_SIZES = [
    { id: 'tall_portrait', width: 832, height: 1216, label: '세로 832 × 1216', short: '세로' },
    { id: 'wide_landscape', width: 1216, height: 832, label: '가로 1216 × 832', short: '가로' },
    { id: 'portrait', width: 896, height: 1152, label: '세로 896 × 1152', short: '세로' },
    { id: 'landscape', width: 1152, height: 896, label: '가로 1152 × 896', short: '가로' },
    { id: 'square', width: 1024, height: 1024, label: '정사각 1024 × 1024', short: '정사각형' },
] as const

export const painterImageSizeById = (id: unknown) => PAINTER_IMAGE_SIZES.find(size => size.id === id)

/** Missing on legacy settings: only the untouched old default (832 × 1216) becomes AI choice. */
export function painterSizeMode(settings: Pick<PainterSettings, 'sizeMode' | 'width' | 'height'>): 'ai' | 'fixed' {
    return settings.sizeMode ?? (settings.width === 832 && settings.height === 1216 ? 'ai' : 'fixed')
}

/** The canvas an image request uses: the planner's choice in AI mode, otherwise the fixed setting. */
export function painterImageSize(settings: PainterSettings, draft?: Pick<PainterDraft, 'size'>): { width: number; height: number } {
    if (painterSizeMode(settings) === 'fixed') return { width: settings.width, height: settings.height }
    const { width, height } = painterImageSizeById(draft?.size) ?? PAINTER_IMAGE_SIZES[0]
    return { width, height }
}

export interface PainterSettings {
    styleId: string
    model: typeof PAINTER_IMAGE_MODELS[number]
    modelSlot: 'model' | 'submodel'
    /** 'ai' lets the planner pick from PAINTER_IMAGE_SIZES; width and height keep the fixed choice. */
    sizeMode?: 'ai' | 'fixed'
    width: number
    height: number
    seed: number | null
    instruction: string
    /** Scene-local camera selection; missing legacy values use third-person. */
    perspective?: 'first-person' | 'third-person'
    context: PainterContext
}

export interface PainterIdentity {
    id: string
    name: string
    aliases: string[]
    appearance: string
    /** Identification hints (relations, titles, epithets) the planner reads to recognize this character. */
    note?: string
    outfitIds?: string[]
    defaultOutfitId?: string
    /** Explicit opt-in for public character cards; missing means private. */
    attachToCard?: boolean
}

/** Reusable generation options; scene-specific instructions and references stay in the chat. */
export type PainterGenerationSettings = Pick<PainterSettings, 'model' | 'modelSlot' | 'sizeMode' | 'width' | 'height' | 'seed'> & {
    context: Omit<PainterContext, 'wikiIds' | 'referenceId' | 'referenceAssetId'>
}

export function painterGenerationSettings(settings: PainterSettings): PainterGenerationSettings {
    const { model, modelSlot, width, height, seed } = settings
    const { before, after, surrounding, systemPrompt, characterDescription, persona, characterLorebook, moduleLorebook } = settings.context
    return { model, modelSlot, sizeMode: painterSizeMode(settings), width, height, seed,
        context: { before, after, surrounding, systemPrompt, characterDescription, persona, characterLorebook, moduleLorebook } }
}

export interface PainterOutfit {
    id: string
    /** Empty for an independent template; legacy values identify its owning character preset. */
    subjectId: string
    name: string
    clothing: string
    state: string
    /** Explicit card opt-in; legacy owned outfits also require their identity to be attached. */
    attachToCard?: boolean
}

export interface PainterResult {
    id: string
    assetId: string
    createdAt: number
    anchor: PainterAnchor
    draft: PainterDraft
    style: PainterStyle
    settings: PainterSettings
    seed: number
    inserted?: 'before' | 'after'
    compressionPending?: boolean
}

export interface PainterChatData {
    settings: PainterSettings
    /** Applied snapshot, independent of chat/global toggle values. */
    imagePreset?: { promptPresetId: string; name: string; values: Record<string, string> }
    /** Missing on legacy chats: preserve their existing local generation options. */
    settingsScope?: 'global' | 'chat'
    anchor?: PainterAnchor
    draft?: PainterDraft
    outfits: PainterOutfit[]
    results: PainterResult[]
    conversation?: Array<{ id: string; role: 'user' | 'assistant'; text: string }>
    previousDraft?: PainterDraft
}

export interface PainterLibraryData {
    identities: PainterIdentity[]
    outfits: PainterOutfit[]
}

/** A global outfit selected for one bot. The outfit itself stays in the global library. */
export interface PainterBotOutfitRef {
    id: string
    /** Card opt-in for this bot; exported cards receive a snapshot of the global outfit. */
    attachToCard?: boolean
}

export interface PainterBotData extends PainterLibraryData {
    settings?: PainterGenerationSettings
    globalOutfits?: PainterBotOutfitRef[]
}

export interface PainterContextSource { name: string; content: string }

export function createPainterSettings(): PainterSettings {
    return {
        styleId: 'default', model: 'nai-diffusion-5-full', modelSlot: 'model', sizeMode: 'ai',
        width: 832, height: 1216, seed: null, instruction: '', perspective: 'third-person',
        context: {
            before: 2, after: 0, surrounding: false, systemPrompt: false,
            characterDescription: true, persona: false, characterLorebook: false,
            moduleLorebook: false, wikiIds: [], referenceId: '',
        },
    }
}

export function createPainterChatData(defaultStyleId = 'default'): PainterChatData {
    return { settings: { ...createPainterSettings(), styleId: defaultStyleId }, settingsScope: 'global', outfits: [], results: [] }
}
