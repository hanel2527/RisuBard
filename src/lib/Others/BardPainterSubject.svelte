<script lang="ts">
    import type { PainterSubject } from 'src/ts/bardPainter/types'
    import type { getPainterSession } from 'src/ts/bardPainter/runtime.svelte'
    import { replaceSubjectAppearance, subjectPromptText, updateSubjectPrompt } from 'src/ts/bardPainter/subjectPrompt'

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
    let localOutfits = $derived(session.data.outfits.filter(outfit => outfit.subjectId === subject.id))
    let sharedOutfits = $derived(session.bot.outfits.filter(outfit => outfit.subjectId === subject.id))

    function save() { void session.persist() }
    function chooseOutfit(event: Event) {
        selectedOutfit = (event.currentTarget as HTMLSelectElement).value
        if (selectedOutfit) void session.applyOutfit(subject.id, selectedOutfit)
    }
    function chooseIdentity(event: Event) {
        const select = event.currentTarget as HTMLSelectElement
        const identity = session.bot.identities.find(item => item.id === select.value)
        if (!identity) return
        if (session.data.draft?.subjects.some(item => item !== subject && item.id === identity.id)) {
            notice = '이 인물은 다른 블록에서 이미 사용 중입니다. 해당 블록에서 편집해 주세요.'
            select.value = selectedIdentity
            return
        }
        selectedIdentity = identity.id
        selectedOutfit = ''
        notice = ''
        replaceSubjectAppearance(subject, identity.appearance)
        subject.name = identity.name
        subject.aliases = [...identity.aliases]
        subject.id = identity.id
        save()
    }
    function editPrompt(event: Event) {
        updateSubjectPrompt(subject, (event.currentTarget as HTMLTextAreaElement).value)
        selectedOutfit = ''
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
                <label>캐릭터 불러오기
                    <select aria-label={`대상 ${index + 1} 캐릭터 불러오기`} value={selectedIdentity} onchange={chooseIdentity}>
                        <option value="">외형 프리셋 선택</option>
                        {#each session.bot.identities as identity (identity.id)}<option value={identity.id}>{identity.name}</option>{/each}
                    </select>
                </label>
                <label>의상 불러오기
                    <select aria-label={`대상 ${index + 1} 의상 불러오기`} value={selectedOutfit} onchange={chooseOutfit}>
                        <option value="">{localOutfits.length + sharedOutfits.length ? '의상 프리셋 선택' : '저장된 의상 없음'}</option>
                        {#each localOutfits as outfit (outfit.id)}<option value={outfit.id}>{outfit.name} (현재 챗)</option>{/each}
                        {#each sharedOutfits as outfit (outfit.id)}<option value={outfit.id}>{outfit.name} (봇 공용)</option>{/each}
                    </select>
                </label>
            </div>
        {/if}
        <label>프롬프트
            <textarea aria-label={`대상 ${index + 1} 프롬프트`} rows="5" spellcheck="false" value={subjectPromptText(subject)} oninput={editPrompt} onblur={save}></textarea>
        </label>
        <p class="hint">빈 줄로 외형, 의상과 상태, 포즈와 표정을 구분합니다. 프리셋을 불러오면 외형은 첫 문단, 의상은 두 번째 문단만 바뀝니다.</p>
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
                    <label>제외할 요소<textarea aria-label={`대상 ${index + 1} 네거티브 프롬프트`} rows="2" spellcheck="false" bind:value={subject.negative} onblur={save}></textarea></label>
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
    .check { flex-direction: row; align-items: center; min-height: 2.75rem; }
    input:not([type='checkbox']), select, textarea { border: 1px solid var(--color-darkborderc); background: var(--color-bgcolor); color: var(--color-textcolor); border-radius: .4rem; padding: .6rem; min-width: 0; width: 100%; }
    input, select { min-height: 2.75rem; }
    input[type='checkbox'] { width: 1rem; height: 1rem; min-height: 0; accent-color: var(--color-primary); flex-shrink: 0; }
    textarea { resize: vertical; min-height: 4rem; line-height: 1.5; font-family: inherit; }
    .hint { color: var(--color-textcolor2); font-size: .78rem; line-height: 1.5; }
    button { min-height: 2.75rem; border: 1px solid var(--color-darkborderc); border-radius: .4rem; padding: .4rem .65rem; font-size: .8rem; overflow-wrap: anywhere; }
    button:hover:not(:disabled) { background: var(--color-darkbutton); }
    button:disabled, fieldset:disabled { opacity: .6; }
    input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    .subtle { align-self: flex-start; }
    .nested { border-top: 1px solid var(--color-darkborderc); }
    .nested summary { padding: .65rem 0; font-size: .85rem; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .footer { padding-top: .2rem; }
    .remove { margin-left: auto; }
    .danger { color: var(--color-danger); }
</style>
