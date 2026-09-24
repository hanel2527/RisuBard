<script lang="ts">
    import { Buffer } from 'buffer'
    import { untrack } from 'svelte'
    import { Image, X } from '@lucide/svelte'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import type { getPainterSession } from 'src/ts/bardPainter/runtime.svelte'

    let { session, disabled = false }: { session: ReturnType<typeof getPainterSession>; disabled?: boolean } = $props()
    let busy = $state(false), error = $state(''), broken = $state(false)
    let version = 0
    const context = $derived(session.data.settings.context)
    const selectedAssetId = $derived(context.referenceAssetId || session.data.results.find(result => result.id === context.referenceId)?.assetId || '')
    const locked = $derived(disabled || busy || session.state.status !== 'idle' || session.state.pendingImage)
    const thumbnail = $derived(selectedAssetId ? `/api/asset/${Buffer.from('inlay_thumb/' + selectedAssetId, 'utf-8').toString('hex')}` : '')
    $effect(() => { selectedAssetId; broken = false })
    $effect(() => {
        session.characterId; session.chatId
        untrack(() => { busy = false; error = ''; version++ })
        return () => { version++ }
    })

    async function clear() {
        if (locked || !selectedAssetId) return
        const target = session, currentVersion = version
        busy = true; error = ''
        try {
            const saved = await target.setReference('')
            if (!saved && currentVersion === version) error = target.state.error || '참고 삽화를 비우지 못했습니다. 진행 중인 작업을 마친 뒤 다시 시도해 주세요.'
        } catch (cause) { if (currentVersion === version) error = cause instanceof Error ? cause.message : String(cause) }
        finally { if (currentVersion === version) busy = false }
    }
    function imageError(event: Event) {
        const image = event.currentTarget as HTMLImageElement
        const original = `/api/asset/${Buffer.from('inlay/' + selectedAssetId, 'utf-8').toString('hex')}`
        if (!image.src.endsWith(original)) image.src = original
        else broken = true
    }
</script>

<section data-painter-reference class="space-y-2 rounded-md border border-darkborderc p-3">
    <div class="flex items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
            {#if selectedAssetId && !broken}<img src={thumbnail} alt="선택한 참고 삽화" class="h-14 w-14 shrink-0 rounded object-cover" onerror={imageError}/>{:else}<Image size={22} class="shrink-0 text-textcolor2"/>{/if}
            <div class="text-sm font-medium text-textcolor">외형과 의상 참고 삽화<span class="mt-1 block text-xs font-normal text-textcolor2">{selectedAssetId ? '현재 챗의 참고 삽화가 지정되어 있습니다.' : '선택하지 않음'}</span></div>
        </div>
        {#if selectedAssetId}<ShButton variant="ghost" size="sm" disabled={locked} onclick={() => void clear()}><X size={14}/>비우기</ShButton>{/if}
    </div>
    <p class="text-xs leading-relaxed text-textcolor2">왼쪽 캐릭터 디스플레이 &gt; 그림 갤러리에서 그림을 열고 '참고 삽화 지정'을 누르세요.</p>
    {#if busy}<p role="status" class="text-xs text-textcolor2">참고 삽화를 비우고 저장하는 중...</p>{/if}
    {#if error}<p role="alert" class="text-sm text-draculared">{error}</p>{/if}
</section>
