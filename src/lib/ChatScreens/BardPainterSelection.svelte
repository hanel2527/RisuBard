<script lang="ts">
    import { onMount } from 'svelte'
    import { get } from 'svelte/store'
    import { v4 } from 'uuid'
    import { DBState } from 'src/ts/stores.svelte'
    import { capturePainterSelection } from 'src/ts/bardPainter/selection'
    import { painterSelection, painterInsertionRequest } from 'src/ts/bardPainter/selectionState'
    import BardPainterPlacement from './BardPainterPlacement.svelte'
    import { resolvePersonaById } from 'src/ts/personaScopes'

    let { characterId, chatId }: { characterId: string; chatId: string } = $props()
    // Capture only; prompt preparation belongs to the panel's explicit button.
    let contextVersion = 0
    $effect(() => {
        painterSelection.set({ characterId, chatId })
        contextVersion += 1
    })

    onMount(() => {
        let timer: ReturnType<typeof setTimeout>
        const capture = () => {
            if (get(painterInsertionRequest)) return
            const selection = window.getSelection()
            // Clicking panel controls or clearing a browser highlight keeps the captured scene.
            if (!selection?.rangeCount || selection.isCollapsed) return
            const range = selection.getRangeAt(0)
            const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
            const root = element?.closest<HTMLElement>('[data-painter-message]')
            if (!root) return
            const issue = (text: string) => painterSelection.set({ characterId, chatId, issue: text })
            if (!root.contains(range.endContainer)) { issue('한 메시지 안에서 그릴 부분을 선택해 주세요.'); return }
            const character = DBState.db.characters.find(item => item.chaId === characterId)
            const chat = character?.chats.find(item => item.id === chatId)
            const message = chat?.message?.[Number(root.dataset.painterMessage)]
            if (!message || chat?.isStreaming) return
            const user = resolvePersonaById(DBState.db, character, chat.bindedPersona)?.persona.name ?? DBState.db.username ?? 'User'
            const bot = character.nickname || character.name
            const captured = capturePainterSelection(root, message.data, selection, { user, char: bot, bot })
            if (!captured || captured.issue === 'empty') return
            // The visible passage remains usable after arbitrary display transforms.
            // Without exact text offsets, insertion can use this message's boundaries.
            const position = captured.range ?? { start: 0, end: message.data.length, insertionUnavailable: true }
            message.chatId ||= v4()
            painterSelection.set({ characterId, chatId, anchor: {
                characterId, chatId, messageId: message.chatId, ...position, text: captured.text,
            } })
        }
        const update = () => {
            clearTimeout(timer)
            const capturedVersion = contextVersion
            timer = setTimeout(() => {
                if (capturedVersion === contextVersion) capture()
            }, 100)
        }
        const finishSelection = () => {
            clearTimeout(timer)
            capture()
        }
        document.addEventListener('selectionchange', update)
        document.addEventListener('mouseup', finishSelection)
        document.addEventListener('keyup', finishSelection)
        return () => {
            clearTimeout(timer)
            document.removeEventListener('selectionchange', update)
            document.removeEventListener('mouseup', finishSelection)
            document.removeEventListener('keyup', finishSelection)
        }
    })
</script>

<BardPainterPlacement {characterId} {chatId}/>
