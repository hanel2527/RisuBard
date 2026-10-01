<script lang="ts">
    import { onDestroy, untrack } from 'svelte';
    import { getCustomBackground, getEmotion } from "../../ts/util";
    
    import { DBState, risuBardGalleryOpen } from 'src/ts/stores.svelte';
    import { CharEmotion, selectedCharID, openModuleListStore } from "../../ts/stores.svelte";
    import { v4 } from 'uuid';
    import ResizeBox from './ResizeBox.svelte'
    import DefaultChatScreen from "./DefaultChatScreen.svelte";
    import defaultWallpaper from '../../etc/bg.jpg'
    import ChatList from "../Others/ChatList.svelte";
    import TransitionImage from "./TransitionImage.svelte";
    import BackgroundDom from "./BackgroundDom.svelte";
    import SideBarArrow from "../UI/GUI/SideBarArrow.svelte";
    import ModuleChatMenu from "../Setting/Pages/Module/ModuleChatMenu.svelte";
    import RisuBardSaveSlotsDialog from '../SideBars/RisuBardSaveSlotsDialog.svelte';
    import RisuBardGallery from '../SideBars/RisuBardGallery.svelte';
    import { ensureChatHydrated } from 'src/ts/storage/chatStorage';
    import { alertConfirm, notifyError, notifyInfo, notifySuccess } from 'src/ts/alert';
    import { changeChatTo, createChatCopyName, forageStorage, requestImmediateSave } from 'src/ts/globalApi.svelte';
    import type { Chat, WikiChatRecoveryPending, WikiChatRecoveryStep } from 'src/ts/storage/database.svelte';
    import { completeMemoryWikiFork } from 'src/ts/risubard/memoryWikiFork';
    import { countChatTurns, createMemorySaveSlot, deleteMemorySaveSlot, latestChatMessageId, listAllMemorySaveSlots, prepareMemorySaveLoad, prepareReferenceSaveLoad, shouldConfirmMemorySaveLoad, writeReferenceAutosave, type MemorySaveSlotSummary } from 'src/ts/risubard/memorySaveSlots';
    import { ensureWikiBaselineForChat } from 'src/ts/risubard/wikiChatCoordinator';
    import { checkoutWikiVersion, forkWikiVersion, captureWikiVersion, listWikiHistory, discardWikiFork } from 'src/ts/risubard/wikiVersionClient';
    import { cleanupWikiRebootWorkspace } from 'src/ts/risubard/wikiRebootTransport';
    import { autoSaveId, normalizeAutosaveInterval, normalizeAutosaveRetention, obsoleteAutosaveIds, quickSaveId, shouldCreateAutosave } from 'src/ts/risubard/memorySavePolicy';
    import { isWikiGenerating } from 'src/ts/risubard/wikiGenerationState';
    import { resolveChatTextSurface } from 'src/ts/gui/textTheme';
    import { chatGenKey, generationStates } from 'src/ts/process/generationState';
    import { activateWikiEmbeddings, activateHistoricalSourceEmbeddings, refreshHistoricalSourceEmbeddings, stopHistoricalSourceEmbeddings, wikiEmbeddingRuntime } from 'src/ts/risubard/wikiEmbeddingService';
    import { resolveRisuBardChatSettings } from 'src/ts/risubard/risuBardSettings';
    import { RISUBARD_MEMORY_UPDATED_EVENT, announceRisuBardMemoryUpdated, type RisuBardMemoryUpdatedDetail } from 'src/ts/risubard/memoryEvents';
    let openChatList = $state(false)
    let openModuleList = $state(false)
    let saveSlotsOpen = $state(false)
    let saveSlotsMode = $state<'save' | 'load'>('load')
    let savingSlot = $state(false)
    let currentCharacter = $derived(
        $selectedCharID >= 0 ? DBState.db.characters[$selectedCharID] : undefined
    )
    let galleryCharacter = $derived(
        currentCharacter?.type === 'character' ? currentCharacter : undefined
    )

    onDestroy(() => { wikiEmbeddingRuntime.stop(); stopHistoricalSourceEmbeddings() })

    $effect(() => {
        const characterId = currentCharacter?.chaId
        const chatId = currentCharacter?.chats[currentCharacter.chatPage]?.id
        const settings = DBState.db
        if (!characterId || !chatId) {
            wikiEmbeddingRuntime.stop()
            stopHistoricalSourceEmbeddings()
            return
        }
        activateWikiEmbeddings(characterId, chatId, settings)
        const chat = currentCharacter?.chats[currentCharacter.chatPage]
        const resolved = resolveRisuBardChatSettings(settings, chat?.risuBardSettings, currentCharacter?.risuBardPinnedSettings)
        const messageCount = chat?.message.length
        if (chat && !chat._placeholder && resolved.risuBardHistoricalSourceMatchLimit > 0) {
            activateHistoricalSourceEmbeddings(characterId, chatId, settings)
            if (!chat.isStreaming && messageCount) untrack(() => refreshHistoricalSourceEmbeddings(characterId, chatId, settings, chat.message, resolved.risuBardIgnoreOocTurns))
        } else stopHistoricalSourceEmbeddings()
        const refresh = (event: Event) => {
            const detail = (event as CustomEvent<RisuBardMemoryUpdatedDetail>).detail
            if (detail?.characterId === characterId && detail.chatId === chatId) {
                wikiEmbeddingRuntime.refresh()
            }
        }
        window.addEventListener(RISUBARD_MEMORY_UPDATED_EVENT, refresh)
        return () => {
            window.removeEventListener(RISUBARD_MEMORY_UPDATED_EVENT, refresh)
        }
    })

    async function retryPendingChatRecovery(
        characterId: string,
        characterChats: Chat[],
        chat: Chat,
        pending: WikiChatRecoveryPending,
    ): Promise<void> {
        const recoveryId = pending.id
        const context = {
            characterId,
            chatId: chat.id!,
            fetchImpl: fetch,
            createAuth: () => forageStorage.createAuth(),
        }
        const isCurrent = () => characterChats.includes(chat)
            && chat.risuBardWikiRecoveryPending?.id === recoveryId
        while (isCurrent() && pending.steps[0]?.kind !== 'save-chat') {
            const step = pending.steps[0]
            if (!step) return
            switch (step.kind) {
                case 'checkout':
                    if (!step.commitId || !step.reason) {
                        throw new Error('Pending Memory Wiki checkout is missing its commit or reason.')
                    }
                    await checkoutWikiVersion({
                        ...context, chatId: step.chatId,
                        commitId: step.commitId, reason: step.reason,
                        chat,
                    })
                    break
                case 'discard-fork':
                    await discardWikiFork({ ...context, chatId: step.chatId })
                    break
                case 'discard-memory-fork':
                    if (!step.forkToken) {
                        throw new Error('Pending Memory Wiki fork cleanup is missing its token.')
                    }
                    await completeMemoryWikiFork({
                        characterId,
                        destinationChatId: step.chatId,
                        forkToken: step.forkToken,
                        action: 'discard',
                        fetchImpl: fetch,
                        createAuth: () => forageStorage.createAuth(),
                    })
                    break
                case 'cleanup-workspace':
                    if (!step.stagingChatId) {
                        throw new Error('Pending reboot cleanup is missing its staging chat ID.')
                    }
                    await cleanupWikiRebootWorkspace({
                        characterId,
                        stagingChatId: step.stagingChatId,
                        fetchImpl: fetch,
                        createAuth: () => forageStorage.createAuth(),
                    })
                    break
                case 'save-chat':
                    return
            }
            if (!isCurrent()) return
            pending.steps.shift()
            try {
                await requestImmediateSave({ forceFullWrite: true, rejectOnFailure: true })
            }
            catch (error) {
                if (isCurrent()) pending.steps.unshift(step)
                throw error
            }
        }
        if (!isCurrent()) return
        const saveStep = pending.steps[0]
        if (!saveStep || saveStep.kind !== 'save-chat') {
            throw new Error('Pending Memory Wiki recovery has no final chat-save step.')
        }
        pending.steps.shift()
        delete chat.risuBardWikiRecoveryPending
        try {
            await requestImmediateSave({ forceFullWrite: true, rejectOnFailure: true })
        }
        catch (error) {
            if (!chat.risuBardWikiRecoveryPending
                || chat.risuBardWikiRecoveryPending.id === recoveryId) {
                pending.error = `${pending.error}; recovery save failed: ${error instanceof Error
                    ? error.message : String(error)}`
                pending.steps = [saveStep]
                chat.risuBardWikiRecoveryPending = pending
                try {
                    await requestImmediateSave({ forceFullWrite: true, rejectOnFailure: true })
                }
                catch (retryError) {
                    pending.error = `${pending.error}; pending-state save failed: ${retryError instanceof Error
                        ? retryError.message : String(retryError)}`
                }
            }
            throw error
        }
        if (chat.risuBardWikiRecoveryPending) return
        announceRisuBardMemoryUpdated({ characterId, chatId: chat.id! })
    }

    $effect(() => {
        const character = currentCharacter
        const chat = character?.chats[character.chatPage]
        if (!character?.chaId || !chat?.id || chat._placeholder) return
        const characterId = character.chaId
        const chatId = chat.id
        let disposed = false
        let running = false
        let initialized = false
        let previousHead: string | null | undefined
        let recoveryRetryAt = 0
        const context = {
            characterId, chatId, fetchImpl: fetch,
            createAuth: () => forageStorage.createAuth(),
        }
        const synchronize = async () => {
            if (disposed || !initialized || running || document.visibilityState === 'hidden') return
            running = true
            try {
                if (chat.risuBardWikiRecoveryPending) {
                    if (Date.now() < recoveryRetryAt) return
                    recoveryRetryAt = Date.now() + 30_000
                    await retryPendingChatRecovery(
                        characterId, character.chats, chat,
                        chat.risuBardWikiRecoveryPending,
                    )
                    if (chat.risuBardWikiRecoveryPending) return
                }
                const captured = await captureWikiVersion(context)
                const head = (await listWikiHistory(context))[0]?.commitId ?? null
                if (!disposed && (captured.commitId
                    || (previousHead !== undefined && previousHead !== head))) {
                    announceRisuBardMemoryUpdated({ characterId, chatId })
                }
                previousHead = head
            }
            catch (error) {
                console.warn('[BardWiki synchronization]', error)
            }
            finally { running = false }
        }
        untrack(() => {
            void (async () => {
                if (!chat.risuBardWikiRecoveryPending) {
                    let changed = false
                    for (const item of chat.message) {
                        if (!item.chatId) { item.chatId = v4(); changed = true }
                    }
                    if (changed) await requestImmediateSave({
                        forceFullWrite: true, rejectOnFailure: true,
                    })
                    await ensureWikiBaselineForChat(context, $state.snapshot(chat.message))
                }
                initialized = true
                await synchronize()
            })().catch((error) => console.warn('[BardWiki baseline]', error))
        })
        const timer = window.setInterval(synchronize, 3000)
        window.addEventListener('focus', synchronize)
        return () => {
            disposed = true
            window.clearInterval(timer)
            window.removeEventListener('focus', synchronize)
        }
    })

    function openSaveSlots(mode: 'save' | 'load'): void {
        if(savingSlot) return
        saveSlotsMode = mode
        saveSlotsOpen = true
    }

    async function saveCurrentChat(
        saveId?: string,
        overwrite = saveId !== undefined,
        options: { silent?: boolean } = {},
    ): Promise<MemorySaveSlotSummary> {
        const character = currentCharacter
        if(savingSlot || !character) throw new Error('현재 채팅을 저장할 수 없습니다.')
        const chatIdx = character.chatPage
        savingSlot = true
        try {
            if(character.chats[chatIdx]?._placeholder){
                await ensureChatHydrated(character.chats, chatIdx, character.chaId)
            }
            const chat = character.chats[chatIdx]
            if(!chat || chat._placeholder){
                throw new Error('채팅 전체 내용을 불러오지 못했습니다.')
            }
            if(chat.isStreaming){
                throw new Error('응답 생성이 끝난 뒤 채팅을 저장해 주세요.')
            }
            if(!character.chaId || !chat.id){
                throw new Error('채팅 저장에는 안정적인 캐릭터와 채팅 ID가 필요합니다.')
            }
            await requestImmediateSave({ rejectOnFailure: true })
            const saved = await createMemorySaveSlot({
                characterId: character.chaId,
                chat,
                saveId: saveId ?? v4(),
                overwrite,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            if(!options.silent){
                notifySuccess('채팅, 변수와 Memory Wiki를 저장했습니다.')
            }
            return saved
        }
        finally {
            savingSlot = false
        }
    }

    async function currentSaveSlots(
        characterId: string,
        chatId: string,
    ): Promise<MemorySaveSlotSummary[]> {
        return listAllMemorySaveSlots({
            characterId,
            sourceChatId: chatId,
            fetchImpl: fetch,
            createAuth: () => forageStorage.createAuth(),
        })
    }

    async function quickSaveCurrentChat(): Promise<void> {
        const character = currentCharacter
        const chat = character?.chats[character.chatPage]
        if(!character?.chaId || !chat?.id || chat._placeholder || savingSlot) return
        const saveId = quickSaveId(chat.id)
        const slots = await currentSaveSlots(character.chaId, chat.id)
        await saveCurrentChat(
            saveId,
            slots.some((slot) => slot.saveId === saveId),
            { silent: true },
        )
        notifySuccess('퀵세이브를 저장했습니다.')
    }

    async function quickLoadCurrentChat(): Promise<void> {
        const character = currentCharacter
        const chat = character?.chats[character.chatPage]
        if(!character?.chaId || !chat?.id || chat._placeholder || savingSlot) return
        const saveId = quickSaveId(chat.id)
        const slots = await currentSaveSlots(character.chaId, chat.id)
        const quickSlot = slots.find((slot) => slot.saveId === saveId)
        if(!quickSlot){
            notifyInfo('아직 퀵세이브 파일이 없습니다.')
            return
        }
        if(shouldConfirmMemorySaveLoad(latestChatMessageId(chat.message), [quickSlot])
            && !await alertConfirm('저장하지 않은 채팅은 사라집니다. 퀵로드할까요?')) return
        await loadSavedChat(saveId)
    }

    async function autosaveCurrentChat(
        characterId: string,
        chatId: string,
        turnCount: number,
        interval: number,
        retention: number,
    ): Promise<void> {
        const character = currentCharacter
        const chat = character?.chats[character.chatPage]
        if(!character || character.chaId !== characterId || chat?.id !== chatId
            || chat._placeholder || chat.isStreaming || savingSlot) return
        const previousTurn = chat.risuBardLastAutosaveTurn
        chat.risuBardLastAutosaveTurn = turnCount
        try {
            const slots = await currentSaveSlots(characterId, chatId)
            if(savingSlot) {
                chat.risuBardLastAutosaveTurn = previousTurn
                return
            }
            const saveId = autoSaveId(chatId, turnCount, interval, retention)
            // Reference autosave: the wiki is referenced by the commit it sits
            // at, so no workspace copy happens here.
            await requestImmediateSave({ rejectOnFailure: true })
            await writeReferenceAutosave({
                characterId,
                chat,
                saveId,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            for (const obsoleteId of obsoleteAutosaveIds(
                slots.map((slot) => slot.saveId),
                chatId,
                retention,
            )) {
                await deleteMemorySaveSlot({
                    characterId,
                    saveId: obsoleteId,
                    fetchImpl: fetch,
                    createAuth: () => forageStorage.createAuth(),
                })
            }
            await requestImmediateSave()
        }
        catch(error){
            chat.risuBardLastAutosaveTurn = previousTurn
            console.warn('[RisuBard autosave]', error)
        }
    }

    async function loadSavedChat(saveId: string, asNewChat = false): Promise<void> {
        const character = currentCharacter
        if(!character?.chaId) return
        const chatIdx = character.chatPage
        if(character.chats[chatIdx]?._placeholder){
            await ensureChatHydrated(character.chats, chatIdx, character.chaId)
        }
        const currentChat = character.chats[chatIdx]
        if(!currentChat?.id || currentChat._placeholder){
            throw new Error('현재 채팅 전체 내용을 불러오지 못했습니다.')
        }
        if(currentChat.isStreaming){
            throw new Error('응답 생성이 끝난 뒤 저장 파일을 불러와 주세요.')
        }
        if(currentChat.risuBardWikiRecoveryPending){
            throw new Error(`Memory Wiki recovery is pending: ${currentChat.risuBardWikiRecoveryPending.error}`)
        }
        const destinationChatId = asNewChat ? v4() : currentChat.id
        // Reference saves carry no wiki copy: their wiki is materialized from
        // the pinned commit, so they take a different load path.
        const reference = await prepareReferenceSaveLoad({
            characterId: character.chaId,
            saveId,
            currentChat,
            destinationChatId,
            fetchImpl: fetch,
            createAuth: () => forageStorage.createAuth(),
        })
        let loadedChat: Chat
        let forkToken: string | null = null
        if(reference){
            loadedChat = reference.chat
        }
        else {
            const prepared = await prepareMemorySaveLoad({
                characterId: character.chaId,
                saveId,
                currentChat,
                destinationChatId,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            loadedChat = prepared.chat
            forkToken = prepared.forkToken
        }
        loadedChat.id = destinationChatId
        loadedChat.isStreaming = false
        delete loadedChat.activeStreamingDisplayOptimizationMode
        delete loadedChat._placeholder
        if(asNewChat) loadedChat.name = createChatCopyName(loadedChat.name, 'Copy')
        if(reference?.wikiCommitId){
            const transport = {
                characterId: character.chaId, fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            }
            if(asNewChat){
                await forkWikiVersion({
                    ...transport, sourceChatId: reference.sourceChatId,
                    destinationChatId, commitId: reference.wikiCommitId, chat: loadedChat,
                })
                character.chats.unshift(loadedChat)
            }
            else {
                await checkoutWikiVersion({
                    ...transport, chatId: destinationChatId,
                    commitId: reference.wikiCommitId, reason: 'save-load', chat: loadedChat,
                })
                character.chats[chatIdx] = loadedChat
            }
            character.chats = character.chats
            changeChatTo(asNewChat ? 0 : chatIdx)
            await requestImmediateSave({ forceFullWrite: true, rejectOnFailure: true })
            saveSlotsOpen = false
            notifySuccess('스토리 불러오기 완료', { duration: 3000 })
            return
        }
        if(forkToken){
            await completeMemoryWikiFork({
                characterId: character.chaId,
                destinationChatId,
                forkToken,
                action: 'finalize',
                chat: $state.snapshot(loadedChat),
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
        }
        if(asNewChat) character.chats.unshift(loadedChat)
        else character.chats[chatIdx] = loadedChat
        character.chats = character.chats
        await requestImmediateSave({ forceFullWrite: true, rejectOnFailure: true })
        changeChatTo(asNewChat ? 0 : chatIdx)
        saveSlotsOpen = false
        notifySuccess('스토리 불러오기 완료', { duration: 3000 })
    }

    $effect(() => {
        if ($openModuleListStore) {
            openModuleList = true
            openModuleListStore.set(false)
        }
    })

    $effect(() => {
        const character = currentCharacter
        const chat = character?.chats[character.chatPage]
        if(!character?.chaId || !chat?.id || chat._placeholder || chat.isStreaming
            || savingSlot || $isWikiGenerating
            || $generationStates.has(chatGenKey(chat.id))) return
        const turnCount = countChatTurns(chat.message)
        const interval = normalizeAutosaveInterval(DBState.db.risuBardAutosaveInterval)
        const retention = normalizeAutosaveRetention(DBState.db.risuBardAutosaveRetention)
        if(shouldCreateAutosave(
            turnCount,
            interval,
            chat.risuBardLastAutosaveTurn,
        )) {
            void autosaveCurrentChat(
                character.chaId,
                chat.id,
                turnCount,
                interval,
                retention,
            )
        }
    })

    const wallPaper = `background: url(${defaultWallpaper})`
    const chatTextSurface = $derived(resolveChatTextSurface(DBState.db.colorScheme, DBState.db))
    const externalStyles = $derived(chatTextSurface.active ?
            ("background: " + chatTextSurface.background + ';\n')
        +   (DBState.db.textBorder ? "text-shadow: -1px -1px 0 var(--color-shadow), 1px -1px 0 var(--color-shadow), -1px 1px 0 var(--color-shadow), 1px 1px 0 var(--color-shadow);" : '')
        +   (DBState.db.textScreenRounded ? "border-radius: 2rem; padding: 1rem;" : '')
        +   (DBState.db.textScreenBorder ? `border: 0.3rem solid ${DBState.db.textScreenBorder};` : '') : '')
    let bgImg= $state('')
    let lastBg = $state('')
    $effect.pre(() => {
        (async () =>{
            if(DBState.db.customBackground !== lastBg){
                lastBg = DBState.db.customBackground
                bgImg = await getCustomBackground(DBState.db.customBackground)
            }
        })()
    });
</script>

{#snippet chatChrome()}
    <SideBarArrow />
{/snippet}

{#snippet chatViewport(customStyle: string)}
    {#if $risuBardGalleryOpen && galleryCharacter}
        <div
            data-gallery-scroll
            class="h-full w-full overflow-y-auto overscroll-y-contain relative default-chat-screen"
        >
            <RisuBardGallery
                chara={galleryCharacter}
                {customStyle}
                onClose={() => risuBardGalleryOpen.set(false)}
            />
        </div>
    {:else}
        <DefaultChatScreen {customStyle} bind:openChatList bind:openModuleList onSaveChat={() => openSaveSlots('save')} onOpenChatLoad={() => openSaveSlots('load')} onQuickSave={quickSaveCurrentChat} onQuickLoad={quickLoadCurrentChat} {savingSlot}/>
    {/if}
{/snippet}

<div class="relative flex h-full min-h-0 min-w-0 w-full" data-chat-dock-workspace>
{#if DBState.db.theme === 'waifu'}
    <div class="grow flex-1 h-full min-h-0 min-w-0 flex justify-center relative overflow-hidden" style="{bgImg.length < 4 ? wallPaper : bgImg}">
        {@render chatChrome()}
        <BackgroundDom />
        {#if $selectedCharID >= 0}
            {#if DBState.db.characters[$selectedCharID].viewScreen !== 'none'}
                <div class="h-full mr-10 flex justify-end halfw" style:width="{42 * (DBState.db.waifuWidth2 / 100)}rem">
                    <TransitionImage classType="waifu" src={getEmotion(DBState.db, $CharEmotion, 'plain')}/>
                </div>
            {/if}
        {/if}
        <div class="h-full w-2xl" style:width="{42 * (DBState.db.waifuWidth / 100)}rem" class:halfwp={$selectedCharID >= 0 && DBState.db.characters[$selectedCharID].viewScreen !== 'none'}>
            {@render chatViewport(`${externalStyles}backdrop-filter: blur(4px);`)}
        </div>
    </div>
{:else if DBState.db.theme === 'waifuMobile'}
    <div class="grow flex-1 h-full min-h-0 min-w-0 relative overflow-hidden" style={bgImg.length < 4 ? wallPaper : bgImg}>
        {@render chatChrome()}
        <BackgroundDom />
        <div class="w-full absolute z-10 bottom-0 left-0"
            class:per33={$selectedCharID >= 0 && DBState.db.characters[$selectedCharID].viewScreen !== 'none'}
            class:h-full={!($selectedCharID >= 0 && DBState.db.characters[$selectedCharID].viewScreen !== 'none')}
        >
            {@render chatViewport(`${externalStyles}backdrop-filter: blur(4px);`)}
        </div>
        {#if $selectedCharID >= 0}
            {#if DBState.db.characters[$selectedCharID].viewScreen !== 'none'}
                <div class="h-full w-full absolute bottom-0 left-0 max-w-full">
                    <TransitionImage classType="mobile" src={getEmotion(DBState.db, $CharEmotion, 'plain')}/>
                </div>
            {/if}
        {/if}
    </div>
{:else}
    <div class="grow flex-1 h-full min-h-0 min-w-0 relative justify-center flex overflow-hidden">
        {@render chatChrome()}
        <BackgroundDom />
        <div style={bgImg} class="h-full w-full" class:max-w-6xl={DBState.db.classicMaxWidth}>
            {#if $selectedCharID >= 0}
                {#if DBState.db.characters[$selectedCharID].viewScreen !== 'none' && (!(DBState.db.characters[$selectedCharID] as import('src/ts/storage/database.svelte').character).inlayViewScreen)}
                    <ResizeBox />
                {/if}
            {/if}
            {@render chatViewport(externalStyles)}
        </div>
    </div>
{/if}
</div>
{#if openChatList}
    <ChatList close={() => {openChatList = false}}/>
{:else if openModuleList}
    <ModuleChatMenu close={() => {openModuleList = false}}/>
{/if}

{#if currentCharacter?.chaId}
    <RisuBardSaveSlotsDialog
        open={saveSlotsOpen}
        bind:mode={saveSlotsMode}
        characterId={currentCharacter.chaId}
        characterName={currentCharacter.name}
        currentChatId={currentCharacter.chats[currentCharacter.chatPage]?.id}
        currentChatName={currentCharacter.chats[currentCharacter.chatPage]?.name}
        currentLatestMessageId={latestChatMessageId(
            currentCharacter.chats[currentCharacter.chatPage]?.message ?? []
        )}
        onOpenChange={(open) => { saveSlotsOpen = open }}
        onLoad={loadSavedChat}
        onSave={saveCurrentChat}
    />
{/if}

<style>
    .halfw{
        max-width: calc(50% - 5rem);
    }
    .halfwp{
        max-width: calc(50% - 5rem);
    }
    .per33{
        height: 33.333333%;
    }
</style>
