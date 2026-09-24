<script lang="ts">
    import { Buffer } from 'buffer'
    import { untrack } from 'svelte'
    import { Check, ChevronLeft, ChevronRight, Copy, Images, RefreshCw, Trash2 } from '@lucide/svelte'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import ShDialog from '../UI/GUI/ShDialog.svelte'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import { getInlayAssetBlob, listInlayExplorerItems, removeInlayAsset, type InlayExplorerItem } from 'src/ts/process/files/inlays'
    import type { character } from 'src/ts/storage/database.svelte'
    import { filterPainterGallery, loadPainterGalleryRecord, novelAiGalleryInfo, painterGalleryInfo, preservePainterChatsGallery, PAINTER_GALLERY_DELETED_CHAT, PAINTER_GALLERY_UNASSIGNED, type GalleryGenerationInfo } from 'src/ts/bardPainter/gallery'
    import { readPainterImageMetadata } from 'src/ts/bardPainter/metadata'
    import { requestImmediateSave } from 'src/ts/globalApi.svelte'

    let { bot, disabled = false }: { bot: character; disabled?: boolean } = $props()
    const pageSize = 24
    let items = $state<InlayExplorerItem[]>([])
    let loading = $state(false), deleting = $state(false), loadError = $state('')
    let chatFilter = $state(''), oldestFirst = $state(false), page = $state(0)
    let viewer = $state<InlayExplorerItem | null>(null), viewerOpen = $state(false)
    let info = $state<GalleryGenerationInfo | null>(null), infoLoading = $state(false), infoError = $state(''), originalChatName = $state('')
    let copiedBlock = $state<number | null>(null), imageError = $state(false)
    let loadVersion = 0, viewerVersion = 0
    let referenceBusy = $state(false), referenceError = $state(''), referenceNotice = $state(''), referencePendingScope = $state('')
    let referenceVersion = 0
    let galleryRoot = $state<HTMLElement | null>(null)
    const currentChat = $derived(bot.chats[bot.chatPage])
    const referenceScope = $derived(`${bot.chaId}\0${currentChat?.id ?? ''}\0${viewer?.id ?? ''}`)
    const currentReference = $derived(currentChat?.bardPainter?.settings.context.referenceAssetId
        || currentChat?.bardPainter?.results?.find(result => result.id === currentChat?.bardPainter?.settings.context.referenceId)?.assetId || '')
    const referenceAssigned = $derived(!!viewer && currentReference === viewer.id)
    const referenceReason = $derived.by(() => {
        if (!currentChat?.id || currentChat._placeholder || !Array.isArray(currentChat.message)) return '참고 삽화를 사용할 챗을 먼저 열어 주세요.'
        if (currentChat.isStreaming) return '메시지 생성을 마친 뒤 참고 삽화를 지정해 주세요.'
        if (disabled) return '진행 중인 작업을 마친 뒤 참고 삽화를 지정해 주세요.'
        if (referenceBusy) return '참고 설정을 저장 중입니다.'
        if (infoLoading) return '그림의 생성 정보를 확인하고 있습니다.'
        if (infoError) return '생성 정보를 불러오지 못해 참고 삽화를 지정할 수 없습니다.'
        if (!info?.blocks.some(block => block.text.trim())) return '생성 정보가 없는 그림은 참고 삽화로 지정할 수 없습니다.'
        return ''
    })
    const all = $derived(filterPainterGallery(items, bot.chaId, bot.chats))
    const filtered = $derived(filterPainterGallery(items, bot.chaId, bot.chats, chatFilter, oldestFirst))
    const pageCount = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)))
    const viewerIndex = $derived(filtered.findIndex(item => item.id === viewer?.id))
    const shown = $derived(filtered.slice(page * pageSize, (page + 1) * pageSize))
    const hasDeleted = $derived(all.some(item => !!item.meta?.chatId && !bot.chats.some(chat => chat.id === item.meta?.chatId)))
    const hasUnassigned = $derived(all.some(item => !item.meta?.chatId))
    const chatName = (id: string | undefined) => !id ? '미분류' : bot.chats.find(chat => chat.id === id)?.name || '삭제한 챗'
    const countFor = (id: string) => all.filter(item => item.meta?.chatId === id).length
    const date = (time: number | undefined) => time ? new Date(time).toLocaleString() : '생성 시각 없음'
    const url = (id: string, thumb = false) => `/api/asset/${Buffer.from(`${thumb ? 'inlay_thumb' : 'inlay'}/${id}`, 'utf-8').toString('hex')}`
    function goPage(offset: number) {
        page += offset
        galleryRoot?.scrollIntoView?.({ block: 'start' })
    }

    async function refresh() {
        const version = ++loadVersion, target = bot
        loading = true; loadError = ''
        try {
            // Old painter records migrate only for chats already loaded in memory.
            await preservePainterChatsGallery(target.chats.filter(chat => !chat._placeholder))
            const next = await listInlayExplorerItems(true)
            if (version === loadVersion) items = next
        } catch (error) { if (version === loadVersion) loadError = String(error) }
        finally { if (version === loadVersion) loading = false }
    }

    $effect(() => {
        bot.chaId
        untrack(() => { items = []; chatFilter = ''; page = 0; viewerOpen = false; viewer = null; void refresh() })
        return () => { loadVersion++; viewerVersion++ }
    })
    $effect(() => { chatFilter; oldestFirst; page = 0 })
    $effect(() => { if (page >= pageCount) page = pageCount - 1 })
    $effect(() => { if (!referenceAssigned) referenceNotice = '' })
    $effect(() => {
        referenceScope; viewerOpen
        untrack(() => { referenceVersion++; referenceError = ''; referenceNotice = '' })
        return () => { referenceVersion++ }
    })

    async function assignReference() {
        if (!viewer || !viewerOpen || referenceReason || referenceAssigned || referenceBusy || !currentChat?.id) return
        // Gallery filtering and image ownership do not change the current chat assignment target.
        const characterId = bot.chaId, chatId = currentChat.id, assetId = viewer.id
        const version = referenceVersion, scope = referenceScope
        referenceBusy = true; referencePendingScope = scope; referenceError = ''; referenceNotice = ''
        try {
            const { getPainterSession } = await import('src/ts/bardPainter/runtime.svelte')
            const session = getPainterSession(characterId, chatId)
            const saved = await session.setReference(assetId)
            if (version !== referenceVersion) return
            if (!saved) { referenceError = session.state.error || '참고 삽화를 지정하지 못했습니다. 다시 시도해 주세요.'; return }
            referenceNotice = '참고 삽화로 지정했습니다.'
        } catch (cause) {
            if (version === referenceVersion) referenceError = cause instanceof Error ? cause.message : String(cause)
        } finally { referenceBusy = false; referencePendingScope = '' }
    }

    async function openImage(item: InlayExplorerItem) {
        const version = ++viewerVersion
        viewer = item; viewerOpen = true; info = null; infoLoading = true; infoError = ''; originalChatName = ''; copiedBlock = null; imageError = false
        try {
            const record = await loadPainterGalleryRecord(item.id)
            let next: GalleryGenerationInfo | null = null
            if (record) next = painterGalleryInfo(record)
            else {
                // Only this opened image is decoded; gallery thumbnails never fetch original bytes.
                const asset = await getInlayAssetBlob(item.id)
                if (asset) next = novelAiGalleryInfo(readPainterImageMetadata(new Uint8Array(await asset.data.arrayBuffer())))
            }
            if (version === viewerVersion) { info = next; originalChatName = record?.chatName ?? '' }
        } catch { if (version === viewerVersion) infoError = '생성 정보를 불러오지 못했습니다. 그림은 그대로 볼 수 있습니다.' }
        finally { if (version === viewerVersion) infoLoading = false }
    }

    async function copy(value: string, index: number) {
        try { await navigator.clipboard.writeText(value); copiedBlock = index }
        catch { notifyError('복사하지 못했습니다. 텍스트를 직접 선택해 복사해 주세요.') }
    }

    async function deleteChatImages() {
        if (!chatFilter || !filtered.length || deleting) return
        const targets = [...filtered], targetBot = bot
        const label = chatFilter === PAINTER_GALLERY_DELETED_CHAT ? '삭제한 챗' : chatFilter === PAINTER_GALLERY_UNASSIGNED ? '미분류' : chatName(chatFilter)
        if (!await alertConfirm(`「${label}」의 그림 ${targets.length}장을 모두 삭제할까요? 이미지 파일과 생성 기록을 삭제합니다. 본문에 삽입한 그림도 더 이상 표시되지 않으며 되돌릴 수 없습니다.`)) return
        deleting = true
        const removed = new Set<string>()
        try {
            const { isPainterChatBusy } = await import('src/ts/bardPainter/runtime.svelte')
            const targetIds = new Set(targets.map(item => item.id))
            if (targets.some(item => item.meta?.chatId && isPainterChatBusy(targetBot.chaId, item.meta.chatId))
                || targetBot.chats.some(chat => chat.bardPainter?.results?.some(result => targetIds.has(result.assetId) && result.compressionPending))) {
                notifyError('바드페인터 작업이나 이미지 저장을 마친 뒤 그림을 삭제해 주세요.')
                return
            }
            for (const item of targets) {
                try { await removeInlayAsset(item.id); removed.add(item.id) } catch { /* Report partial failure below. */ }
            }
            // Retire loaded legacy records so entering the gallery cannot recreate deleted sidecars.
            for (const chat of targetBot.chats) if (chat.bardPainter) chat.bardPainter.results = (chat.bardPainter.results ?? []).filter(result => !removed.has(result.assetId))
            items = items.filter(item => !removed.has(item.id))
            if (viewer && removed.has(viewer.id)) { viewerOpen = false; viewer = null; viewerVersion++ }
            if (removed.size !== targets.length) notifyError(`${removed.size}장 삭제, ${targets.length - removed.size}장 실패했습니다. 새로고침 후 다시 시도해 주세요.`)
            else notifySuccess(`${removed.size}장을 삭제했습니다.`)
            if (removed.size) await requestImmediateSave()
        } catch (error) { notifyError(`그림 정리를 마치지 못했습니다: ${String(error)}`) }
        finally { deleting = false }
    }
</script>

<section bind:this={galleryRoot} data-painter-gallery class="space-y-3">
    <div class="flex items-center justify-between gap-2">
        <h3 class="font-semibold text-textcolor">그림 갤러리 <span class="text-sm font-normal text-textcolor2">{all.length}장</span></h3>
        <ShButton variant="ghost" size="icon-sm" aria-label="갤러리 새로고침" title="새로고침" disabled={disabled || loading || deleting} onclick={() => void refresh()}><RefreshCw size={16}/></ShButton>
    </div>
    <p class="text-xs leading-relaxed text-textcolor2">챗을 삭제해도 그림은 남습니다. 그림을 누르면 크게 보고 프롬프트를 복사하거나 참고 삽화로 지정할 수 있습니다.</p>
    <label class="block text-sm text-textcolor">챗
        <select aria-label="갤러리 챗" value={chatFilter} onchange={(event) => chatFilter = event.currentTarget.value} disabled={deleting} class="mt-1 w-full rounded-md border border-darkborderc bg-darkbg p-2 text-textcolor">
            <option value="">모두 ({all.length}장)</option>
            {#each bot.chats as chat (chat.id)}<option value={chat.id}>{chat.name || '이름 없는 챗'} ({countFor(chat.id)}장)</option>{/each}
            {#if hasDeleted || chatFilter === PAINTER_GALLERY_DELETED_CHAT}<option value={PAINTER_GALLERY_DELETED_CHAT}>삭제한 챗</option>{/if}
            {#if hasUnassigned || chatFilter === PAINTER_GALLERY_UNASSIGNED}<option value={PAINTER_GALLERY_UNASSIGNED}>미분류</option>{/if}
        </select>
    </label>
    <div class="flex flex-wrap items-center justify-between gap-2">
        <select aria-label="그림 생성 순서" value={oldestFirst ? 'oldest' : 'newest'} onchange={(event) => oldestFirst = event.currentTarget.value === 'oldest'} class="min-h-9 rounded-md border border-darkborderc bg-darkbg px-2 text-sm text-textcolor">
            <option value="newest">최근 생성순</option><option value="oldest">오래된 생성순</option>
        </select>
        {#if chatFilter}<ShButton variant="ghost" size="sm" className="text-draculared" disabled={disabled || deleting || loading || !filtered.length} onclick={() => void deleteChatImages()}><Trash2 size={14}/>{deleting ? '삭제 중...' : '이 분류 모두 삭제'}</ShButton>{/if}
    </div>
    {#if loadError}<p role="alert" class="text-sm text-draculared">그림 목록을 불러오지 못했습니다. 새로고침으로 다시 시도해 주세요.</p>{/if}
    {#if loading && !items.length}<p role="status" class="py-8 text-center text-sm text-textcolor2">그림 목록을 불러오는 중...</p>
    {:else if !filtered.length}<div class="rounded-md border border-dashed border-darkborderc p-6 text-center text-textcolor2"><Images size={28} class="mx-auto mb-2"/><p class="text-sm">이 분류에는 그림이 없습니다.</p></div>
    {:else}
        <div class="grid grid-cols-2 gap-2">
            {#each shown as item (item.id)}
                <div class="min-w-0">
                    <button data-gallery-image={item.id} class="w-full overflow-hidden rounded-md border border-darkborderc bg-darkbg text-left text-textcolor focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50" disabled={disabled} onclick={() => void openImage(item)} aria-label={`${chatName(item.meta?.chatId)}, ${date(item.meta?.createdAt)} 그림 확대`}>
                        <img src={url(item.id, true)} alt="" loading="lazy" class="aspect-square w-full object-cover"/>
                        <span class="block truncate px-2 pt-1 text-xs">{chatName(item.meta?.chatId)}</span><span class="block truncate px-2 pb-2 text-[10px] text-textcolor2">{date(item.meta?.createdAt)}</span>
                    </button>
                </div>
            {/each}
        </div>
        <nav aria-label="그림 갤러리 페이지" class="flex items-center justify-center gap-2">
            <ShButton variant="outline" size="icon-sm" aria-label="이전 그림 페이지" disabled={page === 0} onclick={() => goPage(-1)}><ChevronLeft size={16}/></ShButton>
            <span class="text-sm text-textcolor2">{page + 1} / {pageCount}</span>
            <ShButton variant="outline" size="icon-sm" aria-label="다음 그림 페이지" disabled={page + 1 >= pageCount} onclick={() => goPage(1)}><ChevronRight size={16}/></ShButton>
        </nav>
    {/if}
</section>

<ShDialog bind:open={viewerOpen} size="xl" closeOnEscape contentClass="max-w-6xl" closeAriaLabel="그림 닫기">
    {#snippet title()}그림 보기{/snippet}
    {#if viewer}
        <div class="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div class="min-w-0">
                {#if imageError}<p class="p-8 text-center text-textcolor2">이미지를 불러올 수 없습니다.</p>{:else}<img src={url(viewer.id)} alt={`${chatName(viewer.meta?.chatId)}의 삽화`} class="max-h-[72vh] w-full rounded-md object-contain" onerror={() => imageError = true}/>{/if}
                <div class="mt-2 flex items-center justify-center gap-2">
                    <ShButton variant="outline" size="icon-sm" aria-label="이전 그림" disabled={viewerIndex <= 0} onclick={() => void openImage(filtered[viewerIndex - 1])}><ChevronLeft size={16}/></ShButton>
                    <span class="text-sm text-textcolor2">{viewerIndex + 1} / {filtered.length}</span>
                    <ShButton variant="outline" size="icon-sm" aria-label="다음 그림" disabled={viewerIndex < 0 || viewerIndex + 1 >= filtered.length} onclick={() => void openImage(filtered[viewerIndex + 1])}><ChevronRight size={16}/></ShButton>
                </div>
            </div>
            <div class="min-w-0 space-y-3 md:max-h-[76vh] md:overflow-y-auto md:pr-1">
                <p class="text-sm text-textcolor">{chatName(viewer.meta?.chatId)}{#if chatName(viewer.meta?.chatId) === '삭제한 챗' && originalChatName} / {originalChatName}{/if}</p>
                <p class="text-xs text-textcolor2">{date(viewer.meta?.createdAt)}{#if viewer.width && viewer.height} / {viewer.width} × {viewer.height}{/if}</p>
                <div class="space-y-2 rounded-md border border-darkborderc p-3">
                    <p class="text-xs text-textcolor2">현재 챗: {currentChat?.name || '열린 챗 없음'}</p>
                    <div class="flex flex-wrap gap-2">
                        <ShButton data-gallery-reference variant="primary" size="sm" disabled={!!referenceReason || referenceAssigned} onclick={() => void assignReference()}><Check size={14}/>{referenceBusy && referencePendingScope === referenceScope ? '지정하는 중...' : referenceAssigned ? '참고 삽화로 지정됨' : '참고 삽화 지정'}</ShButton>
                        <ShButton variant="outline" size="sm" onclick={() => void copy(`{{inlay::${viewer!.id}}}`, -1)}><Copy size={14}/>{copiedBlock === -1 ? '복사됨' : '본문 삽입 코드 복사'}</ShButton>
                    </div>
                    {#if referenceReason}<p class="text-xs text-textcolor2">{referenceReason}</p>{/if}
                    {#if referenceNotice}<p role="status" class="text-xs text-textcolor2">{referenceNotice}</p>{/if}
                    {#if referenceError}<p data-gallery-reference-error role="alert" class="text-sm text-draculared">{referenceError}</p>{/if}
                </div>
                {#if infoLoading}<p role="status" class="text-sm text-textcolor2">생성 정보를 불러오는 중...</p>{:else if infoError}<p role="status" class="text-sm text-textcolor2">{infoError}</p>
                {:else if info}
                    {#each info.blocks as block, index}
                        <section class="rounded-md border border-darkborderc bg-darkbg p-3">
                            <div class="mb-2 flex items-center justify-between gap-2"><h4 class="text-sm font-medium">{block.title}</h4><ShButton variant="ghost" size="sm" aria-label={`${block.title} 복사`} onclick={() => void copy(block.text, index)}><Copy size={14}/>{copiedBlock === index ? '복사됨' : '복사'}</ShButton></div>
                            <p class="select-text whitespace-pre-wrap break-words text-sm leading-relaxed text-textcolor2">{block.text}</p>
                        </section>
                    {/each}
                    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-textcolor2">{#each info.settings as [label, value]}<dt>{label}</dt><dd class="break-words">{value}</dd>{/each}</dl>
                {:else}<p class="text-sm text-textcolor2">저장된 생성 정보가 없는 그림입니다.</p>{/if}
            </div>
        </div>
    {/if}
</ShDialog>
