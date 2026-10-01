<script lang="ts">
    import { onMount } from 'svelte'
    import { LoaderCircleIcon, RotateCcwIcon, Trash2Icon, TriangleAlertIcon } from '@lucide/svelte'
    import { forageStorage, requestImmediateSave, changeChatTo } from 'src/ts/globalApi.svelte'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import {
        checkoutWikiVersion,
        captureWikiVersion,
        deleteWikiRef,
        listWikiHistory,
        listWikiRefs,
        previewWikiCheckout,
    } from 'src/ts/risubard/wikiVersionClient'
    import { readWikiRecovery, listDeletedWikiRecovery, forkWikiVersion } from 'src/ts/risubard/wikiVersionClient'
    import { preserveWikiChat, anchorMessagesFromChat } from 'src/ts/risubard/wikiChatCoordinator'
    import { decodeMemorySaveChat } from 'src/ts/risubard/memorySaveSlots'
    import { rebindPainterChatScope } from 'src/ts/bardPainter/chatScope'
    import { DBState } from 'src/ts/stores.svelte'
    import type { Chat } from 'src/ts/storage/database.svelte'
    import { restoreScriptstateForPrefix } from 'src/ts/chatScriptstateCheckpoint'
    import { Buffer } from 'buffer'
    import { v4 } from 'uuid'
    import type {
        WikiHistoryEntry,
        WikiRefRecord,
    } from 'src/ts/risubard/wikiVcsContract'
    import { computeWikiPrefixDigest } from 'src/ts/risubard/wikiVcsContract'

    interface Props {
        characterId: string
        chatId: string
        /** Called after the working tree moves so the parent reloads documents. */
        onChanged?(): void
    }

    let { characterId, chatId, onChanged }: Props = $props()

    let history = $state<WikiHistoryEntry[]>([])
    let refs = $state<{ recovery: WikiRefRecord[]; autosave: WikiRefRecord[]; save: WikiRefRecord[] }>({
        recovery: [], autosave: [], save: [],
    })
    let loading = $state(true)
    let busy = $state('')
    let error = $state('')

    const context = () => ({
        characterId,
        chatId,
        fetchImpl: fetch,
        createAuth: () => forageStorage.createAuth(),
    })

    async function refresh(background = false): Promise<void> {
        if (!characterId || !chatId) return
        if (!background) loading = true
        error = ''
        try {
            await captureWikiVersion({ ...context(), poll: background })
            const [nextHistory, nextRefs, deletedRefs] = await Promise.all([
                listWikiHistory(context()),
                listWikiRefs(context()),
                listDeletedWikiRecovery(context()),
            ])
            history = nextHistory
            if (!Array.isArray(nextRefs)) {
                const recovery = new Map(nextRefs.recovery.map((ref) => [ref.id, ref]))
                for (const ref of deletedRefs) recovery.set(ref.id, ref)
                refs = { ...nextRefs, recovery: [...recovery.values()] }
            }
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            loading = false
        }
    }

    async function rewind(entry: WikiHistoryEntry): Promise<void> {
        if (busy) return
        if (!entry.exact) {
            notifyError('이 시점은 정확히 복원할 수 없습니다. 대화로 위키를 다시 구성해야 합니다.')
            return
        }
        busy = entry.commitId
        error = ''
        try {
            const character = DBState.db.characters.find((item) => item.chaId === characterId)
            const chat = character?.chats.find((item) => item.id === chatId)
            if (!chat || chat._placeholder) throw new Error('전체 대화를 먼저 불러와 주세요.')
            const preview = await previewWikiCheckout({
                ...context(),
                commitId: entry.commitId,
                messages: anchorMessagesFromChat(chat.message),
            })
            if (!await alertConfirm(
                `대화와 위키를 이 시점으로 되돌릴까요?\n변경되는 문서: ${preview.changedPaths.length}개\n현재 대화와 위키는 복구 이력에 남습니다.`,
            )) return
            if (!preview.exact) {
                throw new Error('현재 대화의 근거와 이 커밋이 일치하지 않습니다. 복구 이력에서 열어 주세요.')
            }
            const boundaryId = preview.chatAnchor.boundaryMessageId
            const boundary = boundaryId === null ? -1
                : chat.message.findIndex((message) => message.chatId === boundaryId)
            if ((boundaryId !== null && boundary < 0)
                || computeWikiPrefixDigest(anchorMessagesFromChat(
                    chat.message.slice(0, boundary + 1)
                )) !== preview.chatAnchor.prefixDigest) {
                throw new Error('이 시점의 대화가 변경되어 함께 되돌릴 수 없습니다. 복구 이력에서 열어 주세요.')
            }
            const original = $state.snapshot(chat)
            await preserveWikiChat(context(), original, 'truncate')
            const targetChat = $state.snapshot(chat)
            targetChat.message = targetChat.message.slice(0, boundary + 1)
            restoreScriptstateForPrefix(targetChat, targetChat.message, original.message)
            await checkoutWikiVersion({
                ...context(), commitId: entry.commitId, reason: 'truncate',
                chat: targetChat,
            })
            Object.assign(chat, targetChat)
            notifySuccess('대화와 위키를 이 시점으로 되돌렸습니다.')
            onChanged?.()
            await refresh()
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            busy = ''
        }
    }

    async function recover(ref: WikiRefRecord, asNew: boolean): Promise<void> {
        if (busy || !ref.chatId || !ref.chatStateRef) return
        if (!await alertConfirm(asNew
            ? '이 복구 기록으로 새 채팅을 만들까요?'
            : '대화와 위키를 함께 복원할까요? 현재 대화는 복구 이력에 보존됩니다.')) return
        busy = ref.id
        const owner = { ...context(), chatId: ref.chatId }
        const character = DBState.db.characters.find((item) => item.chaId === characterId)
        if (!character) { busy = ''; return }
        const originalIndex = character.chats.findIndex((chat) => chat.id === ref.chatId)
        const original = originalIndex >= 0
            ? $state.snapshot(character.chats[originalIndex]) : undefined
        const destinationChatId = asNew ? v4() : ref.chatId
        let wikiChanged = false
        try {
            const saved = await readWikiRecovery({ ...owner, id: ref.id })
            const decoded = decodeMemorySaveChat(
                Uint8Array.from(Buffer.from(saved.chatBase64, 'base64'))
            )
            if (!decoded || typeof decoded !== 'object'
                || !('message' in decoded) || !Array.isArray(decoded.message)
                || !('name' in decoded) || typeof decoded.name !== 'string') {
                throw new Error('복구 대화 형식이 올바르지 않습니다.')
            }
            const restored = decoded as Chat
            restored.id = destinationChatId
            restored.isStreaming = false
            delete restored._placeholder
            delete restored.risuBardWikiReboot
            rebindPainterChatScope(restored, characterId)
            if (!asNew && original) {
                await preserveWikiChat(owner, original, 'purge-restore')
            }
            if (asNew) {
                await forkWikiVersion({
                    ...context(), sourceChatId: ref.chatId,
                    destinationChatId, commitId: ref.commitId,
                    chat: restored,
                })
            }
            else {
                await checkoutWikiVersion({
                    ...owner, commitId: ref.commitId, reason: 'purge-restore',
                    chat: restored,
                })
            }
            wikiChanged = true
            if (!asNew && original) character.chats[originalIndex] = restored
            else {
                character.chats.unshift(restored)
            }
            await requestImmediateSave({ forceFullWrite: true, rejectOnFailure: true })
            changeChatTo(character.chats.findIndex((chat) => chat.id === destinationChatId))
            notifySuccess('대화와 위키를 복원했습니다.')
            onChanged?.()
            await refresh()
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
            if (wikiChanged) onChanged?.()
        }
        finally { busy = '' }
    }

    async function purge(ref: WikiRefRecord): Promise<void> {
        if (busy) return
        if (!await alertConfirm(
            '이 복구 이력을 영구 삭제할까요?\n다른 분기나 세이브가 같은 내용을 참조하면 그 내용은 남습니다.',
        )) return
        busy = ref.id
        try {
            await deleteWikiRef({
                ...context(), chatId: ref.chatId ?? chatId, kind: ref.kind, id: ref.id,
            })
            notifySuccess('복구 이력을 삭제했습니다.')
            await refresh()
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            busy = ''
        }
    }

    onMount(() => {
        const timer = window.setInterval(() => {
            if (!busy && document.visibilityState !== 'hidden') void refresh(true)
        }, 3000)
        return () => window.clearInterval(timer)
    })

    $effect(() => {
        void characterId
        void chatId
        void refresh()
    })
</script>

<div class="wiki-history" data-wiki-history>
    {#if loading}
        <p class="wiki-history-status"><LoaderCircleIcon size={16} /> 이력을 불러오는 중…</p>
    {:else if error}
        <p class="wiki-history-status error"><TriangleAlertIcon size={16} /> {error}</p>
    {:else}
        <section>
            <h4>커밋 이력</h4>
            {#if history.length === 0}
                <p class="wiki-history-status">아직 기록된 커밋이 없습니다.</p>
            {:else}
                <ul>
                    {#each history as entry (entry.commitId)}
                        <li data-wiki-commit={entry.commitId}>
                            <div class="row">
                                <span class="kind">{entry.kind}</span>
                                <time>{entry.createdAt.replace('T', ' ').slice(0, 19)}</time>
                            </div>
                            <div class="meta">
                                {entry.changedPaths.length}개 문서
                                {#if !entry.exact}<span class="warn">기록 시작 이전</span>{/if}
                            </div>
                            <button
                                type="button"
                                disabled={busy !== '' || !entry.exact}
                                onclick={() => rewind(entry)}
                            ><RotateCcwIcon size={14} /> 이 시점으로</button>
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>

        <section>
            <h4>복구 이력</h4>
            {#if refs.recovery.length === 0}
                <p class="wiki-history-status">복구용으로 남은 이력이 없습니다.</p>
            {:else}
                <ul>
                    {#each refs.recovery as ref (ref.id)}
                        <li data-wiki-ref={ref.id}>
                            <div class="row">
                                <span class="kind">{ref.reason ?? 'recovery'}</span>
                                <time>{ref.createdAt.replace('T', ' ').slice(0, 19)}</time>
                            </div>
                            <div class="meta">{ref.commitId.slice(0, 12)}</div>
                            {#if ref.chatStateRef}
                                <button type="button" disabled={busy !== ''} onclick={() => recover(ref, false)}>
                                    <RotateCcwIcon size={14} /> 대화와 위키 복원
                                </button>
                                <button type="button" disabled={busy !== ''} onclick={() => recover(ref, true)}>
                                    새 채팅으로 열기
                                </button>
                            {/if}
                            <button
                                type="button"
                                disabled={busy !== ''}
                                onclick={() => purge(ref)}
                            ><Trash2Icon size={14} /> 영구 삭제</button>
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>
    {/if}
</div>

<style>
    .wiki-history {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        padding: 0.75rem;
        overflow-y: auto;
        height: 100%;
        font-size: 0.85rem;
    }

    h4 {
        margin: 0 0 0.5rem;
        font-size: 0.85rem;
        opacity: 0.8;
    }

    ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    li {
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 6px;
        padding: 0.5rem;
    }

    .row {
        display: flex;
        justify-content: space-between;
        gap: 0.5rem;
    }

    .kind {
        font-weight: 600;
    }

    time,
    .meta {
        opacity: 0.7;
        font-size: 0.78rem;
    }

    .warn {
        color: var(--risu-theme-warningcolor);
        margin-left: 0.5rem;
    }

    .wiki-history-status {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        opacity: 0.8;
    }

    .wiki-history-status.error {
        color: var(--risu-theme-dangercolor);
    }

    button {
        margin-top: 0.4rem;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 4px;
        padding: 0.2rem 0.5rem;
        background: transparent;
        color: inherit;
        cursor: pointer;
    }

    button:disabled {
        opacity: 0.5;
        cursor: default;
    }
</style>
