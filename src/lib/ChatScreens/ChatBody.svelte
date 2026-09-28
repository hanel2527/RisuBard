<script lang="ts">
    import isEqual from "lodash/isEqual"
    import { onDestroy } from "svelte"
    import { doingChat } from "src/ts/process/generationState"
    import { DBState } from 'src/ts/stores.svelte'
    import { sleep } from "src/ts/util"
    import { alertError } from "../../ts/alert"
    import { addMetadataToElement, getDistance, ParseMarkdown, postTranslationParse, resolveInlayPlaceholders, trimMarkdown, type CbsConditions, type simpleCharacterArgument } from "../../ts/parser/parser.svelte"
    import { getLLMCache, translateHTML } from "../../ts/translator/translator"
    import { getModuleAssets } from "src/ts/process/modules";
    import { getCurrentCharacter, getCurrentChat } from "src/ts/storage/database.svelte";
    import { getFileSrc } from "src/ts/globalApi.svelte";
    import { clearGenericChatImageStyles, isFirstMessageStudioManagedImage } from './chatImageHandling'
    import { retainedChatHtml } from './retainedChatHtml'
    import { inlayImageControls } from './inlayImageControls'

    interface Props {
        character?: simpleCharacterArgument|string|null
        firstMessage?: boolean
        idx?: number
        msgDisplay?: string
        name?: string
        role: string|null
        translated: boolean
        translating: boolean
        retranslate: boolean
        bodyRoot?: HTMLElement|null
        modelShortName: string
        renderRawStreaming?: boolean
        rawStreamingText?: string
        onRemoveInlay?: (id: string, occurrence: number) => void
    }

    let {
        character = null,
        idx = 0,
        firstMessage = false,
        msgDisplay,
        role,
        translated = $bindable(false),
        translating = $bindable(false),
        retranslate = $bindable(false),
        bodyRoot,
        modelShortName = '',
        renderRawStreaming = false,
        rawStreamingText = '',
        onRemoveInlay,
    }: Props =  $props()

    // Keep parser/translation work tied to the exact render that started it.
    // A message can change while ParseMarkdown or the translator is pending,
    // and a chat switch can reuse this component before that work settles.
    // svelte-ignore non_reactive_update
    let lastParsed = ''
    let lastCharArg:string|simpleCharacterArgument = null
    let lastChatId = -10
    let lastChatKey: string | undefined
    let lastChatObject: unknown
    let lastRole: string|null|undefined
    let lastTranslationPolicyKey: string | undefined
    let lastData: string | undefined
    let lastTranslationKey: {
        data: string
        charArg: string | simpleCharacterArgument
        chatID: number
        chatKey: string | undefined
        chatObject: unknown
        role: string|null
        translatorType: unknown
        legacyTranslation: unknown
        translateBeforeHTMLFormatting: unknown
        autoTranslateCachedOnly: unknown
        generationActive: boolean
    } | undefined
    let lastTranslationResult: string | undefined
    let autoTranslationRevision = 0
    onDestroy(() => { autoTranslationRevision += 1 })

    function getCbsCondition(){
        try{
            const cbsConditions:CbsConditions = {
                firstmsg: firstMessage ?? false,
                chatRole: role,
            }
            return cbsConditions
        }
        catch(e){
            return {
                firstmsg: firstMessage ?? false,
                chatRole: null,
            }
        }
    }
    let shouldRenderRawStreaming = $derived(renderRawStreaming && !translated && !retranslate)

    const markParsing = async (data: string, charArg: string | simpleCharacterArgument, chatID: number, tries?:number) => {
        // Every invocation gets its own revision, not just policy changes. This
        // covers streaming chunks as well as a component that survives a chat
        // or history switch while an older request is still pending.
        const revision = ++autoTranslationRevision
        const isCurrent = () => revision === autoTranslationRevision
        // translateHTML intentionally returns its input while generation is
        // active. Subscribe here so it is retried when generation completes,
        // even if the message text itself did not change.
        const generationActive = $doingChat
        // A newer render supersedes any older translation operation. Clear
        // its progress indicator before deciding whether this render starts
        // another request; the newer request will set it again when needed.
        void Promise.resolve().then(() => {
            if (isCurrent()) translating = false
        })
        const chat = getCurrentChat()
        const autoTranslate = role !== 'user' && !!(chat?.autoTranslate ?? DBState.db.autoTranslate)
        const chatKey = chat?.id
        const autoTranslateCachedOnly = !!DBState.db.autoTranslateCachedOnly
        const translatorType = DBState.db.translatorType
        const legacyTranslation = !!DBState.db.legacyTranslation
        const translateBeforeHTMLFormatting = !!DBState.db.translateBeforeHTMLFormatting
        const policyKey = [
            role,
            autoTranslate,
            autoTranslateCachedOnly,
            translatorType,
            legacyTranslation,
            translateBeforeHTMLFormatting,
        ].join('|')
        const contextChanged = !isEqual(lastCharArg, charArg)
            || chatID !== lastChatId
            || chatKey !== lastChatKey
            || chat !== lastChatObject
            || role !== lastRole
        const dataChanged = data !== lastData
        // Cached-only translation is a per-source lookup. A new streaming
        // chunk therefore needs a fresh cache decision even when the chat
        // policy itself did not change.
        const shouldResolveTranslationPolicy = contextChanged
            || policyKey !== lastTranslationPolicyKey
            || (autoTranslate && autoTranslateCachedOnly && dataChanged)

        let lastParsedQueue = ''
        const mode = 'notrim' as const

        if (contextChanged) {
            // Never show a previous chat/message's retained loading HTML.
            lastParsed = ''
            lastTranslationKey = undefined
            lastTranslationResult = undefined
        }

        lastCharArg = charArg
        lastChatId = chatID
        lastChatKey = chatKey
        lastChatObject = chat
        lastRole = role
        lastTranslationPolicyKey = policyKey
        lastData = data

        const setTranslatedLater = (value: boolean) => {
            setTimeout(() => {
                if (isCurrent()) translated = value
            }, 10)
        }

        const withTranslationState = async (work: () => Promise<string>): Promise<string> => {
            if (!isCurrent()) return data
            translating = true
            try {
                return await work()
            }
            finally {
                if (isCurrent()) translating = false
            }
        }

        try {
            if (shouldResolveTranslationPolicy) {
                let translateText = autoTranslate
                if (autoTranslate && autoTranslateCachedOnly && translatorType === 'llm') {
                    try {
                        const cache = translateBeforeHTMLFormatting
                            ? await getLLMCache(data)
                            : !legacyTranslation
                            ? await getLLMCache(await ParseMarkdown(data, charArg, 'pretranslate', chatID, getCbsCondition()))
                            : await getLLMCache(await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition()))
                        translateText = cache !== null
                    }
                    catch (error) {
                        console.error(error)
                        translateText = false
                    }
                }

                if (!isCurrent()) return data
                const lastTranslated = translated
                if (lastTranslated !== translateText) {
                    setTranslatedLater(translateText)
                    // The state update above deliberately causes one more
                    // parse. Returning raw data keeps the await block useful
                    // while that state transition is pending.
                    return data
                }
            }

            if(retranslate || translated){
                const translationKey = {
                    data,
                    charArg,
                    chatID,
                    chatKey,
                    chatObject: chat,
                    role,
                    translatorType,
                    legacyTranslation,
                    translateBeforeHTMLFormatting,
                    autoTranslateCachedOnly,
                    generationActive,
                }
                // A retranslate flag is a one-shot force. Its reset triggers a
                // reactive parse, so reuse the completed result instead of
                // issuing the same request a second time.
                if (!retranslate
                    && lastTranslationResult !== undefined
                    && lastTranslationKey
                    && lastTranslationKey.data === translationKey.data
                    && isEqual(lastTranslationKey.charArg, translationKey.charArg)
                    && lastTranslationKey.chatID === translationKey.chatID
                    && lastTranslationKey.chatKey === translationKey.chatKey
                    && lastTranslationKey.chatObject === translationKey.chatObject
                    && lastTranslationKey.role === translationKey.role
                    && lastTranslationKey.translatorType === translationKey.translatorType
                    && lastTranslationKey.legacyTranslation === translationKey.legacyTranslation
                    && lastTranslationKey.translateBeforeHTMLFormatting === translationKey.translateBeforeHTMLFormatting
                    && lastTranslationKey.autoTranslateCachedOnly === translationKey.autoTranslateCachedOnly
                    && lastTranslationKey.generationActive === translationKey.generationActive) {
                    lastParsedQueue = lastTranslationResult
                    return lastTranslationResult
                }

                if (DBState.db.showTranslationLoading) {
                    lastParsed = `<div style="display:flex;justify-content:center;align-items:center;height:48px;"><div style="animation: spin 1s linear infinite; border-radius: 50%; height: 32px; width: 32px; border: 2px solid var(--color-primary); border-top: 2px solid transparent;"></div></div><style>@keyframes spin { to { transform: rotate(360deg); } }</style>`
                }

                let transResult: string
                if(DBState.db.translatorType === 'llm' && DBState.db.translateBeforeHTMLFormatting){
                    await sleep(100)
                    if (!isCurrent()) return data
                    transResult = await withTranslationState(async () => {
                        const translatedData = await translateHTML(data, false, charArg, chatID, retranslate)
                        return await ParseMarkdown(translatedData, charArg, mode, chatID, getCbsCondition())
                    })
                }
                else if(!DBState.db.legacyTranslation){
                    const marked = await ParseMarkdown(data, charArg, 'pretranslate', chatID, getCbsCondition())
                    if (!isCurrent()) return data
                    transResult = await withTranslationState(async () => {
                        const translatedData = await translateHTML(marked, false, charArg, chatID, retranslate)
                        return await postTranslationParse(translatedData)
                    })
                }
                else{
                    const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition())
                    if (!isCurrent()) return data
                    transResult = await withTranslationState(
                        () => translateHTML(marked, false, charArg, chatID, retranslate)
                    )
                }

                if (!isCurrent()) return data
                lastTranslationKey = translationKey
                lastTranslationResult = transResult
                lastParsedQueue = transResult
                // Resetting retranslate is itself reactive. Guard it so an old
                // request cannot clear a newer manual retranslation.
                if (retranslate) {
                    setTimeout(() => {
                        if (isCurrent()) retranslate = false
                    }, 10)
                }
                return transResult
            }
            else{
                const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition())
                if (!isCurrent()) return data
                lastParsedQueue = marked
                return marked
            }
        } catch (error) {
            if (!isCurrent()) return data
            // retry
            if((tries ?? 0) > 2){
                const message = error instanceof Error ? error.message : String(error)
                const stack = error instanceof Error ? error.stack ?? '' : ''
                alertError(`Error while parsing chat message: ${translated}, ${message}, ${stack}`)
                return data
            }
            return await markParsing(data, charArg, chatID, (tries ?? 0) + 1)
        }
        finally{
            // Since trimMarkdown is fast, we don't need to cache it. More
            // importantly, an old request must not replace current pending
            // content after a message/chat switch.
            if (isCurrent()) lastParsed = lastParsedQueue
        }
    }

    const checkImg = () => {
        if(!DBState.db.newImageHandlingBeta || !bodyRoot){
            return
        }
        const imgs = bodyRoot.querySelectorAll('img:not([src^="data:"]):not([src^="http:"]):not([src^="https:"]):not([src^="blob:"]):not([src^="file:"]):not([src^="tauri:"]):not([src^="/"]):not([noimage])') as NodeListOf<HTMLImageElement>
        
        if (imgs.length > 0) {
            const currentCharacter = getCurrentCharacter()
            const styl = currentCharacter.prebuiltAssetStyle
            const assets = getModuleAssets().concat(currentCharacter.additionalAssets ?? [])
            const normalizedAssets = assets.map((asset) => {
                return {
                    name: asset[0].toLocaleLowerCase(),
                    path: asset[1]
                }
            })
            const exactAssets = new Map(normalizedAssets.map((asset) => [asset.name, asset.path]))

            imgs.forEach(async (img) => {
                const studioManagedImage = isFirstMessageStudioManagedImage(img)
                if (studioManagedImage) clearGenericChatImageStyles(img)
                const name = img.getAttribute('src')?.toLocaleLowerCase() || ''
                console.log(name)

                if(
                    name.length > 200 ||
                    name.includes(':')
                ){
                    img.setAttribute('noimage', 'true')
                    return
                }
                
                const foundAsset = exactAssets.get(name)
                console.log('Checking image:', name, 'Assets:', assets)
                if(foundAsset){
                    if (!studioManagedImage) {
                        img.classList.add('root-loaded-image')
                        img.classList.add('root-loaded-image-' + styl)
                    }
                    img.src = await getFileSrc(foundAsset)
                    return
                }

                if(name.length < 3){
                    img.setAttribute('noimage', 'true')
                    return
                }
                const prefixLoc = name.lastIndexOf('.')
                const prefix = prefixLoc > 0 ? name.substring(0, prefixLoc) : ''
                let currentDistance = 1000
                let currentFound = ''
                for(const asset of normalizedAssets){
                    if(!asset.name.startsWith(prefix)){
                        continue
                    }
                    const distance = getDistance(name, asset.name)
                    if(distance < currentDistance){
                        currentDistance = distance
                        currentFound = asset.path
                    }
                }
                if(currentFound){
                    const got = await getFileSrc(currentFound)
                    const name2 = img.getAttribute('src')?.toLocaleLowerCase() || ''
                    if(name === name2){
                        img.setAttribute('src', got)
                    }

                    if(!studioManagedImage && img.classList.length === 0){
                        img.classList.add('root-loaded-image')
                        img.classList.add('root-loaded-image-' + styl)
                    }
                    img.removeAttribute('noimage')
                }
                else{
                    img.setAttribute('noimage', 'true')
                }
            })
        }
    }

    let markParsingResult = $derived.by(() => markParsing(msgDisplay, character, idx))

    function onHtmlRendered() {
        checkImg()
        if (bodyRoot) resolveInlayPlaceholders(bodyRoot)
    }
</script>

{#if shouldRenderRawStreaming}
    <span class="whitespace-pre-wrap">{rawStreamingText}</span>
{:else}
    <span data-painter-body style="display: contents" use:inlayImageControls={onRemoveInlay} use:retainedChatHtml={{
        content: markParsingResult,
        format: (html) => addMetadataToElement(trimMarkdown(html), modelShortName),
        onRender: onHtmlRendered,
        pendingHtml: (translated || retranslate) && DBState.db.showTranslationLoading ? lastParsed : undefined,
    }}></span>
{/if}

<style>
    :global(.inlay-image-control) {
        position: relative;
        display: inline-block;
        max-width: 100%;
        vertical-align: middle;
    }
    :global(.inlay-image-control > img) { margin: 0; }
    :global(.x-risu-risu-inlay-image > .inlay-image-control) { width: 100%; max-width: 20rem; }
    :global(.inlay-image-remove) {
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2.75rem;
        height: 2.75rem;
        border-radius: 0.5rem;
        border: 1px solid var(--color-darkborderc);
        background: var(--color-darkbg);
        color: var(--color-textcolor);
        opacity: 0;
        pointer-events: none;
        cursor: pointer;
        transition: opacity 150ms;
    }
    :global(.inlay-image-control:hover > .inlay-image-remove),
    :global(.inlay-image-control:focus-within > .inlay-image-remove) {
        opacity: 1;
        pointer-events: auto;
    }
    :global(.inlay-image-remove:hover) { color: var(--color-danger); }
    :global(.inlay-image-remove:focus-visible) { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    @media (hover: none) { :global(.inlay-image-remove) { opacity: 1; pointer-events: auto; } }
    @media (prefers-reduced-motion: reduce) { :global(.inlay-image-remove) { transition: none; } }
</style>
