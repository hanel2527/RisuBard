<script lang="ts">
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import RisuBardFindReplace from '../Others/RisuBardFindReplace.svelte'
    import { DBState } from 'src/ts/stores.svelte'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { loadNarrativeMemoryWiki, type NarrativeMemoryWiki } from 'src/ts/risubard/memoryWiki'
    import { applyChatFindReplace, replaceWikiText } from 'src/ts/risubard/findReplace'
    import { saveChatToServer } from 'src/ts/storage/chatStorage'
    import { announceRisuBardMemoryUpdated } from 'src/ts/risubard/memoryEvents'
    import { isWikiGenerating } from 'src/ts/risubard/wikiGenerationState'
    import { isAnyGenerating } from 'src/ts/process/generationState'
    let { open = $bindable(false), characterId, chatId, blocked = false }: {
        open?: boolean; characterId: string; chatId: string; blocked?: boolean
    } = $props()
    let wiki = $state<NarrativeMemoryWiki | null>(null)
    let loading = $state(false)
    let error = $state('')
    let sequence = 0
    let currentChat = $derived(DBState.db.characters?.find(item => item.chaId === characterId)?.chats.find(item => item.id === chatId))
    async function loadWiki() {
        const request = ++sequence
        loading = true
        error = ''
        try {
            const result = await loadNarrativeMemoryWiki({ characterId, chatId, fetchImpl: fetch, createAuth: () => forageStorage.createAuth() })
            if (request === sequence) wiki = result
        } catch (cause) {
            if (request === sequence) error = String(cause)
        } finally {
            if (request === sequence) loading = false
        }
    }
    $effect(() => {
        if (open && characterId && chatId) void loadWiki()
        return () => { sequence++ }
    })
    async function replaceText(input: {
        find: string
        replacement: string
        wiki: boolean
        chat: boolean
    }) {
        if (blocked || $isWikiGenerating || $isAnyGenerating || currentChat?.isStreaming || currentChat?.risuBardWikiReboot) throw new Error('현재 작업이 끝난 뒤 다시 시도해 주세요.')
        const targetCharacterId = characterId
        const targetChatId = chatId
        let wikiResult = { matches: 0, documents: 0 }
        let chatResult = { matches: 0, messages: 0 }
        const chatTarget = (() => {
            if (!input.chat) return null
            const character = DBState.db.characters?.find((item) =>
                item.chaId === characterId
            )
            const chatIndex = character?.chats.findIndex((item) =>
                item.id === chatId
            ) ?? -1
            const currentChat = chatIndex >= 0
                ? character?.chats[chatIndex]
                : undefined
            if (!character || !currentChat) {
                throw new Error('현재 챗 내역을 찾을 수 없습니다.')
            }
            if (currentChat.isStreaming) {
                throw new Error('답변 생성이 끝난 뒤 챗 내역을 바꿔 주세요.')
            }
            return { character, chatIndex, currentChat }
        })()
        if (input.wiki) {
            wikiResult = await replaceWikiText({
                characterId: targetCharacterId,
                chatId: targetChatId,
                find: input.find,
                replacement: input.replacement,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            await loadWiki()
            announceRisuBardMemoryUpdated({ characterId: targetCharacterId, chatId: targetChatId })
        }
        if (chatTarget) {
            const { character, chatIndex, currentChat } = chatTarget
            const originals = currentChat.message.map((message) => ({
                data: message.data,
                saying: message.saying,
                name: message.name,
                swipes: message.swipes ? [...message.swipes] : undefined,
            }))
            chatResult = applyChatFindReplace(
                currentChat.message,
                input.find,
                input.replacement
            )
            if (chatResult.matches > 0) {
                try {
                    await saveChatToServer(
                        targetCharacterId,
                        chatIndex,
                        targetChatId,
                        currentChat
                    )
                    character.reloadKeys = (character.reloadKeys ?? 0) + 1
                }
                catch (cause) {
                    currentChat.message.forEach((message, index) => {
                        message.data = originals[index].data
                        message.saying = originals[index].saying
                        message.name = originals[index].name
                        message.swipes = originals[index].swipes
                    })
                    throw cause
                }
            }
        }
        return {
            wikiMatches: wikiResult.matches,
            wikiDocuments: wikiResult.documents,
            chatMatches: chatResult.matches,
            chatMessages: chatResult.messages,
        }
    }


</script>

<ShDialog bind:open ariaLabel="찾기/바꾸기" closeOnEscape size="lg">
    {#if loading && !wiki}<p role="status">위키를 불러오는 중입니다…</p>
    {:else if error && !wiki}<p role="alert">{error}</p>
    {:else}
        {#if error}<p role="alert">{error}</p>{/if}
        <RisuBardFindReplace documents={wiki?.mode === 'markdown' ? wiki.documents : []} messages={currentChat?.message ?? []} onReplace={replaceText} />
    {/if}
</ShDialog>
