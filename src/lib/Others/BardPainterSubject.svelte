<script lang="ts">
    import { ClipboardPaste } from '@lucide/svelte'
    import BardPainterPromptInput from './BardPainterPromptInput.svelte'
    import type { PainterSubject } from 'src/ts/bardPainter/types'
    import type { getPainterSession } from 'src/ts/bardPainter/runtime.svelte'
    import { subjectPromptText, updateSubjectPrompt } from 'src/ts/bardPainter/subjectPrompt'

    let { subject, session, disabled = false, index, total, onMove, onRemove }: {
        subject: PainterSubject
        session: ReturnType<typeof getPainterSession>
        disabled?: boolean
        index: number
        total: number
        onMove: (direction: -1 | 1) => void
        onRemove: () => void
    } = $props()
    let selectedOutfit = $state('')
    let selectedIdentity = $state('')
    let outfitName = $state('')
    let moreOpen = $state(false)
    let confirmRemove = $state(false)
    let notice = $state('')
    let localOutfits = $derived(session.data.outfits)
    let sharedOutfits = $derived(session.bot.outfits)
    let identityText = $derived(session.bot.identities.find(item => item.id === selectedIdentity)?.appearance ?? '')
    let outfit = $derived([...localOutfits, ...sharedOutfits].find(item => item.id === selectedOutfit))
    let outfitText = $derived(outfit ? [outfit.clothing, outfit.state].filter(Boolean).join(', ') : '')
    let promptInput: HTMLTextAreaElement | undefined = $state()
    let cursor: { start: number; end: number; text: string } | undefined
    $effect(() => { subject; session; cursor = undefined; selectedIdentity = ''; selectedOutfit = ''; notice = '' })

    function save() { void session.persist() }
    function rememberCursor() {
        if (promptInput) cursor = { start: promptInput.selectionStart, end: promptInput.selectionEnd, text: promptInput.value }
    }
    function pastePreset(text: string) {
        if (disabled || !promptInput || !text.trim()) return
        const input = promptInput
        const range = cursor?.text === input.value ? cursor : { start: input.value.length, end: input.value.length }
        const suffixLength = input.value.length - range.end
        input.focus({ preventScroll: true })
        input.setSelectionRange(range.start, range.end)
        // Native text insertion preserves the browser's undo history when supported.
        let inserted = false
        try { inserted = document.execCommand?.('insertText', false, text) ?? false } catch { /* Fall back to a plain textarea edit. */ }
        if (!inserted) input.setRangeText(text, range.start, range.end, 'end')
        const caret = input.value.length - suffixLength
        input.setSelectionRange(caret, caret)
        updateSubjectPrompt(subject, input.value)
        rememberCursor()
        notice = '프리셋 원문을 붙여넣었습니다.'
        save()
    }
    function editPrompt(event: Event) {
        updateSubjectPrompt(subject, (event.currentTarget as HTMLTextAreaElement).value)
        rememberCursor()
    }
</script>

<details class="subject" open data-painter-subject={subject.id}>
    <summary>
        <span class="subject-title">{subject.kind === 'object' ? '사물' : '인물'} {index + 1} — {subject.name || '이름 없음'}</span>
        {#if subject.locked}<span class="badge">잠김</span>{/if}
    </summary>
    <fieldset {disabled}>
        <label>이름<input aria-label={`대상 ${index + 1} 이름`} bind:value={subject.name} onblur={save} /></label>
        {#if subject.kind === 'character'}
            <div class="grid">
                <div class="preset-insert">
                <label>캐릭터 불러오기
                    <select aria-label={`대상 ${index + 1} 캐릭터 불러오기`} value={selectedIdentity} onchange={event => selectedIdentity = event.currentTarget.value}>
                        <option value="">외형 프리셋 선택</option>
                        {#each session.bot.identities as identity (identity.id)}<option value={identity.id}>{identity.name}</option>{/each}
                    </select>
                </label>
                <button type="button" class="paste-button" title="캐릭터 프리셋 붙여넣기" aria-label={`대상 ${index + 1} 캐릭터 붙여넣기`} disabled={disabled || !identityText.trim()} onclick={() => pastePreset(identityText)}><ClipboardPaste size={18} aria-hidden="true" /></button>
                </div>
                <div class="preset-insert">
                <label>의상 불러오기
                    <select aria-label={`대상 ${index + 1} 의상 불러오기`} value={selectedOutfit} onchange={event => selectedOutfit = event.currentTarget.value}>
                        <option value="">{localOutfits.length + sharedOutfits.length ? '의상 프리셋 선택' : '저장된 의상 없음'}</option>
                        {#each localOutfits as item (item.id)}<option value={item.id}>{session.bot.identities.find(person => person.id === item.subjectId)?.name ?? '인물'} / {item.name} (현재 챗)</option>{/each}
                        {#each sharedOutfits as item (item.id)}<option value={item.id}>{session.bot.identities.find(person => person.id === item.subjectId)?.name ?? '인물'} / {item.name} (봇 공용)</option>{/each}
                    </select>
                </label>
                <button type="button" class="paste-button" title="의상 프리셋 붙여넣기" aria-label={`대상 ${index + 1} 의상 붙여넣기`} disabled={disabled || !outfitText.trim()} onclick={() => pastePreset(outfitText)}><ClipboardPaste size={18} aria-hidden="true" /></button>
                </div>
            </div>
        {/if}
        <label>프롬프트
            <BardPainterPromptInput bind:input={promptInput} aria-label={`대상 ${index + 1} 프롬프트`} rows={5} spellcheck="false" value={subjectPromptText(subject)} oninput={editPrompt} onselect={rememberCursor} onclick={rememberCursor} onkeyup={rememberCursor} onblur={() => { rememberCursor(); save() }}></BardPainterPromptInput>
        </label>
        {#if notice}<p role="status" class="hint">{notice}</p>{/if}
        <details class="nested" bind:open={moreOpen} data-subject-more>
            <summary>더 보기 <span class="hint">프리셋 저장, 잠금, 제외할 요소</span></summary>
            {#if moreOpen}
                <div class="stack">
                    <label class="check"><input type="checkbox" bind:checked={subject.locked} onchange={save} />AI로 개선할 때 이 블록 유지</label>
                    <label>종류<select aria-label={`대상 ${index + 1} 종류`} bind:value={subject.kind} onchange={save}><option value="character">인물</option><option value="object">사물</option></select></label>
                    <label>별칭<span class="hint">쉼표로 구분</span><input aria-label={`대상 ${index + 1} 별칭`} value={subject.aliases.join(', ')} onchange={event => { subject.aliases = event.currentTarget.value.split(',').map(value => value.trim()).filter(Boolean); save() }} /></label>
                    <button type="button" class="subtle" onclick={() => session.rememberIdentity(subject.id)} disabled={!subject.name.trim() || !subject.appearance.trim()}>이름과 외형 프리셋 저장</button>
                    {#if subject.kind === 'character'}
                        <label>저장할 의상 이름<input aria-label={`${subject.name} 저장할 의상 이름`} placeholder="예: 겨울 여행복" bind:value={outfitName} /></label>
                        <button type="button" disabled={!outfitName.trim() || !subject.clothing.trim()} onclick={() => session.saveOutfit(subject.id, outfitName.trim(), true)}>현재 챗에 의상 저장</button>
                        <p class="hint">두 번째 문단의 의상과 상태를 저장합니다. 목록과 봇 공용 저장은 상단 캐릭터 프리셋에서 관리합니다.</p>
                    {/if}
                    <label>제외할 요소<BardPainterPromptInput aria-label={`대상 ${index + 1} 네거티브 프롬프트`} rows={2} spellcheck="false" bind:value={subject.negative} onblur={save}></BardPainterPromptInput></label>
                    <div class="actions footer">
                        <button type="button" aria-label={`${subject.name} 블록 위로 이동`} disabled={index === 0} onclick={() => onMove(-1)}>위로</button>
                        <button type="button" aria-label={`${subject.name} 블록 아래로 이동`} disabled={index === total - 1} onclick={() => onMove(1)}>아래로</button>
                        {#if confirmRemove}
                            <button type="button" class="danger" onclick={onRemove}>블록 삭제 확인</button><button type="button" onclick={() => confirmRemove = false}>취소</button>
                        {:else}<button type="button" class="remove" onclick={() => confirmRemove = true}>블록 삭제</button>{/if}
                    </div>
                </div>
            {/if}
        </details>
    </fieldset>
</details>

<style>
    .subject { border: 1px solid var(--color-darkborderc); border-radius: .65rem; background: var(--color-darkbg); min-width: 0; }
    summary { cursor: pointer; padding: .85rem; min-height: 2.75rem; overflow-wrap: anywhere; }
    .subject-title { font-weight: 600; }
    .badge { color: var(--color-textcolor2); font-size: .75rem; margin-left: .3rem; }
    fieldset, .stack { display: flex; flex-direction: column; gap: .85rem; min-width: 0; }
    fieldset { border: 0; margin: 0; padding: 0 .85rem .85rem; }
    label { display: flex; flex-direction: column; gap: .3rem; font-size: .85rem; min-width: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr)); gap: .75rem; }
    .preset-insert { display: flex; align-items: flex-end; gap: .5rem; min-width: 0; }
    .preset-insert label { flex: 1; }
    .paste-button { display: inline-flex; align-items: center; justify-content: center; width: 2.75rem; height: 2.75rem; flex: none; padding: 0; }
    .check { flex-direction: row; align-items: center; min-height: 2.75rem; }
    input:not([type='checkbox']), select { border: 1px solid var(--color-darkborderc); background: var(--color-bgcolor); color: var(--color-textcolor); border-radius: .4rem; padding: .6rem; min-width: 0; width: 100%; }
    input, select { min-height: 2.75rem; }
    input[type='checkbox'] { width: 1rem; height: 1rem; min-height: 0; accent-color: var(--color-primary); flex-shrink: 0; }
    .hint { color: var(--color-textcolor2); font-size: .78rem; line-height: 1.5; }
    button { min-height: 2.75rem; border: 1px solid var(--color-darkborderc); border-radius: .4rem; padding: .4rem .65rem; font-size: .8rem; overflow-wrap: anywhere; }
    button:hover:not(:disabled) { background: var(--color-darkbutton); }
    button:disabled, fieldset:disabled { opacity: .6; }
    input:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    .subtle { align-self: flex-start; }
    .nested { border-top: 1px solid var(--color-darkborderc); }
    .nested summary { padding: .65rem 0; font-size: .85rem; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .footer { padding-top: .2rem; }
    .remove { margin-left: auto; }
    .danger { color: var(--color-danger); }
</style>
