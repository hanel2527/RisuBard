<script lang="ts">
    import { Buffer } from 'buffer'
    import { BookOpen, Check, Image, LoaderCircle, Minus, Plus, X } from '@lucide/svelte'
    import { tooltip } from 'src/ts/gui/tooltip'
    import type { getPainterSession } from 'src/ts/bardPainter/runtime.svelte'
    import type { PainterContext } from 'src/ts/bardPainter/types'
    import type { TogglePreset } from 'src/ts/storage/database.svelte'
    import BardPainterIconButton from './BardPainterIconButton.svelte'

    let { session, disabled = false, onOpenGallery }: {
        session: ReturnType<typeof getPainterSession>
        disabled?: boolean
        onOpenGallery: () => void
    } = $props()

    type Toggle = 'surrounding' | 'characterDescription' | 'persona' | 'systemPrompt' | 'characterLorebook' | 'moduleLorebook'
    const toggles: Array<{ key: Toggle; label: string; tip: string }> = [
        { key: 'characterDescription', label: '캐릭터 설명', tip: '봇의 캐릭터 설명을 보냅니다.' },
        { key: 'persona', label: '페르소나', tip: '이 챗에 연결된 페르소나 설명을 보냅니다.' },
        { key: 'characterLorebook', label: '캐릭터 로어북', tip: '장면과 이어진 메시지에서 발동한 로어를 보냅니다. 로어에 연결한 캐릭터 프리셋도 이때 알아봅니다.' },
        { key: 'moduleLorebook', label: '모듈 로어북', tip: '활성 모듈의 로어북을 보냅니다.' },
        { key: 'systemPrompt', label: '시스템 프롬프트', tip: '채팅 프롬프트의 시스템 지시를 보냅니다. 이미지 프리셋을 적용하면 항상 포함됩니다.' },
        { key: 'surrounding', label: '메시지 나머지', tip: '장면으로 고른 부분 앞뒤의 같은 메시지 내용을 보냅니다.' },
    ]

    let context = $derived(session.settings.context)
    let wikiIds = $derived(session.data.settings.context.wikiIds)
    let wikiOpen = $state(false)
    let imageChoice = $state<TogglePreset | null | undefined>(undefined)
    let imageChoices = $derived(session.imagePresets)
    let imageChoiceIndex = $derived(imageChoices.find(item => item.preset === imageChoice)?.index)
    let imageChoiceValue = $derived(imageChoice === undefined ? (session.imagePreset ? 'applied' : '') : imageChoice === null ? '' : String(imageChoiceIndex))
    let scope = $derived(session.generationSettingsPinned ? '이 봇에 고정' : session.hasGenerationOverrides ? '이 챗 설정' : '전역값')
    let referenceId = $derived(session.data.settings.context.referenceAssetId || session.data.results.find(result => result.id === session.data.settings.context.referenceId)?.assetId || '')
    let referenceBroken = $state(false)
    $effect(() => { session; session.promptPreset?.id; imageChoice = undefined; wikiOpen = false })
    $effect(() => { referenceId; referenceBroken = false })

    function update(patch: Partial<PainterContext>) { if (!disabled) void session.updateContext(patch) }
    function step(key: 'before' | 'after', delta: number) {
        update({ [key]: Math.max(0, Math.min(20, Math.trunc(context[key] || 0) + delta)) })
    }
    function toggleWiki() {
        wikiOpen = !wikiOpen
        if (wikiOpen && !session.state.wikiDocs.length) void session.loadWiki()
    }
    function selectWiki(id: string, checked: boolean) {
        update({ wikiIds: checked ? [...wikiIds, id] : wikiIds.filter(value => value !== id) })
    }
    async function applyImagePreset() {
        if (disabled || imageChoice === undefined || (imageChoice !== null && imageChoiceIndex === undefined)) return
        const current = session
        if (await current.applyImagePreset(imageChoice === null ? null : imageChoiceIndex!) && current === session) imageChoice = undefined
    }
    const thumbnail = (id: string) => `/api/asset/${Buffer.from(`inlay_thumb/${id}`, 'utf-8').toString('hex')}`
</script>

<section class="context" aria-label="AI에 보낼 참고 자료">
    <div class="heading">
        <h3>참고 자료</h3>
        <span class="scope" use:tooltip={'선택 항목은 생성 설정의 적용 범위를 따릅니다. 바드위키와 참고 삽화는 이 챗에만 저장됩니다.'}>{scope}</span>
    </div>
    <div class="chips" role="group" aria-label="참고 자료 선택">
        <div class="stepper" role="group" aria-label="장면 앞 메시지 수">
            <span>이전 메시지</span>
            <BardPainterIconButton label="이전 메시지 줄이기" disabled={disabled || context.before <= 0} onclick={() => step('before', -1)}><Minus size={14} /></BardPainterIconButton>
            <output aria-live="polite">{context.before}</output>
            <BardPainterIconButton label="이전 메시지 늘리기" disabled={disabled || context.before >= 20} onclick={() => step('before', 1)}><Plus size={14} /></BardPainterIconButton>
        </div>
        <div class="stepper" role="group" aria-label="장면 뒤 메시지 수">
            <span>이후 메시지</span>
            <BardPainterIconButton label="이후 메시지 줄이기" disabled={disabled || context.after <= 0} onclick={() => step('after', -1)}><Minus size={14} /></BardPainterIconButton>
            <output aria-live="polite">{context.after}</output>
            <BardPainterIconButton label="이후 메시지 늘리기" disabled={disabled || context.after >= 20} onclick={() => step('after', 1)}><Plus size={14} /></BardPainterIconButton>
        </div>
        {#each toggles as item (item.key)}
            <button type="button" class="chip" aria-pressed={context[item.key]} {disabled} use:tooltip={item.tip} onclick={() => update({ [item.key]: !context[item.key] })}>
                {#if context[item.key]}<Check size={13} aria-hidden="true" />{/if}{item.label}
            </button>
        {/each}
        <button type="button" class="chip" aria-pressed={wikiIds.length > 0} aria-expanded={wikiOpen} {disabled} onclick={toggleWiki} use:tooltip={'선택한 바드위키 문서만 보냅니다. 위키는 수정하지 않습니다.'}>
            <BookOpen size={13} aria-hidden="true" />바드위키{#if wikiIds.length}<span class="count">{wikiIds.length}</span>{/if}
        </button>
        {#if referenceId}
            <span class="chip reference" aria-pressed="true">
                {#if referenceBroken}<Image size={13} aria-hidden="true" />{:else}<img src={thumbnail(referenceId)} alt="" onerror={() => referenceBroken = true} />{/if}참고 삽화
                <button type="button" class="chip-clear" aria-label="참고 삽화 비우기" {disabled} use:tooltip={'참고 삽화 비우기'} onclick={() => void session.setReference('')}><X size={13} /></button>
            </span>
        {:else}
            <button type="button" class="chip" {disabled} onclick={onOpenGallery} use:tooltip={'갤러리에서 그림을 열고 \'참고 삽화 지정\'을 누르면 그 그림의 외형과 의상을 참고합니다.'}><Image size={13} aria-hidden="true" />참고 삽화</button>
        {/if}
    </div>
    {#if wikiOpen}
        <div class="wiki" aria-label="바드위키 문서 선택">
            {#if session.state.loadingWiki}<p class="hint"><LoaderCircle size={14} class="animate-spin" aria-hidden="true" />위키 목록을 불러오는 중입니다.</p>
            {:else if !session.state.wikiDocs.length}<p class="hint">이 챗에 사용할 수 있는 위키 문서가 없습니다.<button type="button" class="link" onclick={() => void session.loadWiki()}>다시 불러오기</button></p>
            {:else}
                {#each session.state.wikiDocs as doc (doc.id)}
                    <label class="wiki-item"><input type="checkbox" checked={wikiIds.includes(doc.id)} {disabled} onchange={event => selectWiki(doc.id, event.currentTarget.checked)} /><span>{doc.title}</span></label>
                {/each}
                {#if wikiIds.length}<button type="button" class="link" {disabled} onclick={() => update({ wikiIds: [] })}>선택 모두 해제</button>{/if}
            {/if}
        </div>
    {/if}
    {#if imageChoices.length || session.imagePreset}
        <div class="image-preset">
            <label>이미지 프리셋<select aria-label="이미지 프리셋" {disabled} value={imageChoiceValue} use:tooltip={'현재 프롬프트의 커스텀 토글 프리셋을 프롬프트 작성에만 적용합니다. 채팅 토글은 바꾸지 않습니다.'} onchange={event => { imageChoice = event.currentTarget.value === '' ? null : event.currentTarget.value === 'applied' ? undefined : imageChoices.find(item => item.index === Number(event.currentTarget.value))?.preset }}>
                <option value="">사용 안 함</option>
                {#if session.imagePreset}<option value="applied">{session.imagePreset.name} (적용됨)</option>{/if}
                {#each imageChoices as { preset, index }}<option value={String(index)}>{preset.name}</option>{/each}
            </select></label>
            <button type="button" class="apply" disabled={disabled || imageChoice === undefined || (imageChoice !== null && imageChoiceIndex === undefined)} onclick={applyImagePreset}>적용</button>
        </div>
    {/if}
</section>

<style>
    .context { display: flex; flex-direction: column; gap: .6rem; min-width: 0; }
    .heading { display: flex; align-items: baseline; gap: .5rem; }
    h3 { font-size: .85rem; font-weight: 600; color: var(--color-textcolor); }
    .scope { font-size: .72rem; color: var(--color-textcolor2); cursor: help; }
    .chips { display: flex; flex-wrap: wrap; gap: .35rem; min-width: 0; }
    .chip, .stepper { display: inline-flex; align-items: center; gap: .3rem; min-height: 2rem; padding: 0 .65rem; border: 1px solid var(--color-darkborderc); border-radius: 999px; background: transparent; color: var(--color-textcolor2); font-size: .78rem; white-space: nowrap; transition: background-color .15s ease-out, border-color .15s ease-out, color .15s ease-out; }
    .chip:hover:not(:disabled) { color: var(--color-textcolor); background: var(--color-darkbutton); }
    .chip[aria-pressed='true'] { border-color: color-mix(in srgb, var(--color-primary) 55%, var(--color-darkborderc)); background: color-mix(in srgb, var(--color-primary) 12%, transparent); color: var(--color-textcolor); }
    .chip:disabled { opacity: .5; cursor: not-allowed; }
    .chip:focus-visible, .chip-clear:focus-visible, .link:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    .stepper { padding: 0 .15rem 0 .65rem; gap: 0; }
    .stepper span { margin-right: .2rem; }
    .stepper :global(.icon-button) { width: 1.6rem; height: 1.6rem; border-radius: 999px; }
    .stepper output { min-width: 1.1rem; text-align: center; color: var(--color-textcolor); font-variant-numeric: tabular-nums; }
    .count { min-width: 1.1rem; padding: 0 .3rem; border-radius: 999px; background: var(--color-primary); color: var(--color-accenttext); font-size: .7rem; text-align: center; font-variant-numeric: tabular-nums; }
    .reference { padding-left: .3rem; padding-right: .2rem; }
    .reference img { width: 1.5rem; height: 1.5rem; border-radius: 999px; object-fit: cover; }
    .chip-clear { display: inline-grid; place-items: center; width: 1.5rem; height: 1.5rem; border: 0; border-radius: 999px; padding: 0; color: var(--color-textcolor2); background: transparent; }
    .chip-clear:hover:not(:disabled) { color: var(--color-textcolor); background: var(--color-darkbutton); }
    .wiki { display: flex; flex-direction: column; gap: .1rem; max-height: 14rem; overflow: auto; padding: .4rem .5rem; border: 1px solid var(--color-darkborderc); border-radius: .5rem; }
    .wiki-item { display: flex; align-items: center; gap: .5rem; min-height: 2rem; font-size: .8rem; color: var(--color-textcolor); cursor: pointer; overflow-wrap: anywhere; }
    .wiki-item input { width: 1rem; height: 1rem; flex-shrink: 0; accent-color: var(--color-primary); }
    .hint { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; font-size: .78rem; color: var(--color-textcolor2); line-height: 1.5; }
    .link { align-self: flex-start; border: 0; padding: .2rem 0; background: transparent; color: var(--color-textcolor2); font-size: .78rem; text-decoration: underline; text-underline-offset: 3px; }
    .link:hover:not(:disabled) { color: var(--color-textcolor); }
    .image-preset { display: flex; align-items: flex-end; gap: .4rem; min-width: 0; }
    .image-preset label { display: flex; flex: 1; flex-direction: column; gap: .25rem; min-width: 0; font-size: .75rem; color: var(--color-textcolor2); }
    select { width: 100%; min-width: 0; min-height: 2rem; padding: .3rem .5rem; border: 1px solid var(--color-darkborderc); border-radius: .4rem; background: var(--color-bgcolor); color: var(--color-textcolor); font-size: .8rem; }
    select:focus-visible, .apply:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    .apply { min-height: 2rem; padding: 0 .75rem; border: 1px solid var(--color-darkborderc); border-radius: .4rem; font-size: .8rem; }
    .apply:hover:not(:disabled) { background: var(--color-darkbutton); }
    .apply:disabled { opacity: .5; cursor: not-allowed; }
    @media (pointer: coarse) { .chip, .stepper, select, .apply { min-height: 2.75rem; } .stepper :global(.icon-button) { width: 2.4rem; height: 2.4rem; } .chip-clear { width: 2.2rem; height: 2.2rem; } }
</style>
