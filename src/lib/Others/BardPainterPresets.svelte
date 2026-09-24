<script lang="ts">
    import { tick, untrack } from 'svelte'
    import type { getPainterSession } from 'src/ts/bardPainter/runtime.svelte'
    import type { PainterIdentity, PainterOutfit } from 'src/ts/bardPainter/types'

    let { session, disabled = false, expanded = false, onDirtyChange }: {
        session: ReturnType<typeof getPainterSession>; disabled?: boolean; expanded?: boolean; onDirtyChange?: (dirty: boolean) => void
    } = $props()
    type OutfitItem = { outfit: PainterOutfit; shared: boolean }
    type Owner = { id: string; name: string; aliases: string[]; identity?: PainterIdentity; outfits: OutfitItem[] }
    type Editor = {
        kind: 'identity' | 'outfit'; id: string; subjectId: string; exists: boolean; name: string; originalName: string
        aliases: string; appearance: string; clothing: string; state: string; shared: boolean; targetShared: boolean
    }
    let draft = $state<Editor | null>(null)
    let baseline = $state('')
    let query = $state('')
    let scope = $state('all')
    let personLimit = $state(12)
    let outfitLimits = $state<Record<string, number>>({})
    let opened = $state<string[]>([])
    let closedSearch = $state<string[]>([])
    let pendingAction = $state<(() => void) | null>(null)
    let deleting = $state(false)
    let busy = $state(false)
    let feedback = $state('')
    let failed = $state(false)
    let library: HTMLElement | undefined
    let operation = 0
    let locked = $derived(disabled || busy)
    let dirty = $derived(!!draft && JSON.stringify(draft) !== baseline)
    let valid = $derived(!!draft?.name.trim() && (draft.kind === 'identity' || !!draft.clothing.trim()))
    const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim()
    let canCopy = $derived(!!draft && valid && (normalized(draft.name) !== normalized(draft.originalName) || (draft.kind === 'outfit' && draft.targetShared !== draft.shared)))
    let searchWords = $derived(normalized(query).split(/\s+/).filter(Boolean))
    const matches = (value: string) => searchWords.every(word => normalized(value).includes(word))
    let owners = $derived.by(() => {
        const result = new Map<string, Owner>(session.bot.identities.map(person => [person.id, { id: person.id, name: person.name, aliases: person.aliases, identity: person, outfits: [] }]))
        for (const item of [
            ...session.data.outfits.map(outfit => ({ outfit, shared: false })),
            ...session.bot.outfits.map(outfit => ({ outfit, shared: true })),
        ]) {
            const id = item.outfit.subjectId
            if (!result.has(id)) {
                const subject = session.data.draft?.subjects.find(person => person.id === id)
                result.set(id, { id, name: subject?.name || `이름 미등록 (${id.slice(0, 8)})`, aliases: subject?.aliases ?? [], outfits: [] })
            }
            result.get(id)!.outfits.push(item)
        }
        return [...result.values()]
    })
    let folders = $derived(owners.map(person => {
        const personMatches = matches([person.name, ...person.aliases].join(' '))
        const outfits = person.outfits.filter(item => (scope === 'all' || item.shared === (scope === 'shared'))
            && (personMatches || matches([person.name, ...person.aliases, item.outfit.name, item.outfit.clothing, item.outfit.state].join(' '))))
        return { ...person, outfits, visible: (scope === 'all' && personMatches) || outfits.length > 0 }
    }).filter(person => person.visible))
    let owner = $derived(owners.find(person => person.id === draft?.subjectId))

    $effect(() => {
        session
        untrack(() => {
            operation += 1; busy = false; query = ''; scope = 'all'; opened = []; pendingAction = null; feedback = ''; failed = false; resetLimits()
            const first = owners[0]
            if (first) selectIdentity(first); else setEditor(null)
        })
    })
    $effect(() => { onDirtyChange?.(dirty) })

    function setEditor(value: Editor | null) {
        draft = value; baseline = value ? JSON.stringify(value) : ''; deleting = false; pendingAction = null; feedback = ''; failed = false
        if (value?.subjectId && !opened.includes(value.subjectId)) opened = [...opened, value.subjectId]
        if (value?.subjectId) {
            personLimit = Math.max(personLimit, owners.findIndex(person => person.id === value.subjectId) + 1)
            if (value.kind === 'outfit') {
                const person = owners.find(item => item.id === value.subjectId)
                const index = person?.outfits.findIndex(item => item.outfit.id === value.id && item.shared === value.shared) ?? -1
                outfitLimits[value.subjectId] = Math.max(outfitLimits[value.subjectId] ?? 8, index + 1)
            }
        }
        void tick().then(() => library?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest' }))
    }
    function emptyEditor(kind: Editor['kind'], subjectId = ''): Editor {
        return { kind, id: '', subjectId, exists: false, name: '', originalName: '', aliases: '', appearance: '', clothing: '', state: '', shared: false, targetShared: false }
    }
    function selectIdentity(person: Owner) {
        const source = person.identity ?? session.data.draft?.subjects.find(subject => subject.id === person.id)
        setEditor({ ...emptyEditor('identity', person.id), id: person.id, exists: !!person.identity, name: source?.name ?? '', originalName: source?.name ?? '', aliases: source?.aliases.join(', ') ?? '', appearance: source?.appearance ?? '' })
    }
    function selectOutfit(item: OutfitItem) {
        const outfit = item.outfit
        setEditor({ ...emptyEditor('outfit', outfit.subjectId), id: outfit.id, exists: true, name: outfit.name, originalName: outfit.name, clothing: outfit.clothing, state: outfit.state, shared: item.shared, targetShared: item.shared })
    }
    function navigate(action: () => void) {
        if (locked) return
        deleting = false
        if (dirty) pendingAction = action
        else action()
    }
    function discardAndContinue() { const action = pendingAction; pendingAction = null; action?.() }
    function togglePerson(id: string) {
        const isOpen = opened.includes(id) || (searchWords.length > 0 && !closedSearch.includes(id))
        opened = isOpen ? opened.filter(value => value !== id) : [...opened, id]
        closedSearch = isOpen ? [...closedSearch, id] : closedSearch.filter(value => value !== id)
    }
    function resetLimits() { personLimit = 12; outfitLimits = {}; closedSearch = [] }
    function resetFilters() { query = ''; scope = 'all'; resetLimits() }
    function outfitBoundary(item: OutfitItem, direction: -1 | 1) {
        const siblings = (item.shared ? session.bot.outfits : session.data.outfits).filter(outfit => outfit.subjectId === item.outfit.subjectId)
        const target = siblings.findIndex(outfit => outfit.id === item.outfit.id) + direction
        return target < 0 || target >= siblings.length
    }
    async function run<T>(action: () => Promise<T>, onSuccess: (value: NonNullable<T>) => void, message: string) {
        if (locked) return
        const token = ++operation, currentSession = session
        busy = true; failed = false; feedback = ''
        try {
            const value = await action()
            if (token !== operation || currentSession !== session) return
            if (value === undefined || value === null || value === false) { failed = true; feedback = session.state.error || '저장하지 못했습니다. 입력 내용은 그대로 남아 있습니다.'; return }
            onSuccess(value as NonNullable<T>); feedback = message
        } catch (error) {
            if (token === operation && currentSession === session) { failed = true; feedback = error instanceof Error ? error.message : String(error) }
        } finally { if (token === operation && currentSession === session) busy = false }
    }
    function save(asNew = false) {
        if (!draft || !valid || (draft.exists && asNew && !canCopy)) return
        const value = { ...draft }
        if (value.kind === 'identity') {
            const identity = { id: value.id, name: value.name.trim(), aliases: [...new Set(value.aliases.split(',').map(alias => alias.trim()).filter(Boolean))], appearance: value.appearance.trim() }
            void run(() => session.saveIdentity(identity, asNew || !value.id), id => {
                resetFilters()
                selectIdentity({ ...identity, id, identity: { ...identity, id }, outfits: [] })
            }, asNew ? '새 인물 프리셋으로 저장했습니다.' : '인물 프리셋을 저장했습니다.')
        } else {
            const outfit = { id: value.id, subjectId: value.subjectId, name: value.name.trim(), clothing: value.clothing.trim(), state: value.state.trim() }
            const shared = asNew || !value.exists ? value.targetShared : value.shared
            void run(() => session.saveOutfitPreset(outfit, shared, asNew || !value.exists), id => {
                resetFilters(); selectOutfit({ outfit: { ...outfit, id }, shared })
            }, asNew ? '새 의상 프리셋으로 저장했습니다.' : '의상 프리셋을 저장했습니다.')
        }
    }
    function remove() {
        if (!draft?.exists) return
        const value = { ...draft }
        void run(() => value.kind === 'identity' ? session.removeIdentity(value.id) : session.removeOutfit(value.id, value.shared), () => {
            const next = owners.find(person => person.id === value.subjectId) ?? owners[0]
            if (next) selectIdentity(next); else setEditor(null)
        }, value.kind === 'identity' ? '인물과 해당 인물의 의상 프리셋을 삭제했습니다.' : '의상 프리셋을 삭제했습니다.')
    }
    function resetEditor() {
        if (!draft) return
        if (draft.kind === 'identity' && owner) selectIdentity(owner)
        else if (draft.kind === 'outfit' && draft.exists) {
            const saved = (draft.shared ? session.bot.outfits : session.data.outfits).find(item => item.id === draft!.id)
            if (saved) selectOutfit({ outfit: saved, shared: draft.shared })
        } else setEditor(emptyEditor(draft.kind, draft.subjectId))
    }
</script>

<section class="presets" class:embedded={expanded} data-painter-presets>
    {#if !expanded}<h3 class="presets-heading">인물과 의상 프리셋 <span class="hint">인물 {session.bot.identities.length}명 / 의상 {session.data.outfits.length + session.bot.outfits.length}개</span></h3>{/if}
    <div class="content">
        <div class="toolbar">
            <label class="search">인물과 의상 검색<input type="search" aria-label="인물과 의상 검색" placeholder="이름, 별칭, 의상" bind:value={query} oninput={resetLimits} /></label>
            <label>의상 저장 범위<select aria-label="의상 저장 범위" value={scope} onchange={event => { scope = event.currentTarget.value; resetLimits() }}><option value="all">전체</option><option value="local">현재 챗</option><option value="shared">봇 공용</option></select></label>
            <button type="button" disabled={locked} onclick={() => navigate(() => setEditor(emptyEditor('identity')))}>새 인물</button>
        </div>
        {#if query || scope !== 'all'}<div class="filter-note"><span class="hint">인물 {folders.length}명 검색됨</span><button type="button" class="text-button" onclick={resetFilters}>검색과 필터 초기화</button></div>{/if}
        {#if pendingAction}
            <div class="confirmation" role="alert">
                <p>저장하지 않은 변경 내용이 있습니다.</p>
                <div class="actions"><button type="button" disabled={locked} onclick={discardAndContinue}>변경 버리고 계속</button><button type="button" disabled={locked} onclick={() => pendingAction = null}>계속 편집</button></div>
            </div>
        {/if}
        <div class="workspace">
            <nav class="library" aria-label="인물별 프리셋 목록" bind:this={library}>
                {#each folders.slice(0, personLimit) as person (person.id)}
                    {@const isOpen = opened.includes(person.id) || (searchWords.length > 0 && !closedSearch.includes(person.id))}
                    {@const index = session.bot.identities.findIndex(item => item.id === person.id)}
                    <section class="person" data-painter-person={person.id}>
                        <div class="row owner-row" class:selected={draft?.kind === 'identity' && draft.subjectId === person.id}>
                            <button type="button" class="icon-button" aria-label={`${person.name} 의상 ${isOpen ? '접기' : '펼치기'}`} aria-expanded={isOpen} onclick={() => togglePerson(person.id)}><span aria-hidden="true">{isOpen ? '▾' : '▸'}</span></button>
                            <button type="button" class="row-name" disabled={locked} aria-label={`${person.name} 외형 편집`} aria-pressed={draft?.kind === 'identity' && draft.subjectId === person.id} onclick={() => navigate(() => selectIdentity(person))}>
                                <strong>{person.name}</strong><span class="hint">{person.aliases.join(', ') || `${person.outfits.length}개 의상`}</span>
                            </button>
                            {#if person.identity}<div class="reorder"><button type="button" class="icon-button" aria-label={`${person.name} 위로`} title="인물 위로" disabled={locked || index === 0} onclick={() => run(() => session.moveIdentity(person.id, -1), () => {}, '인물 순서를 바꿨습니다.')}><span aria-hidden="true">↑</span></button><button type="button" class="icon-button" aria-label={`${person.name} 아래로`} title="인물 아래로" disabled={locked || index === session.bot.identities.length - 1} onclick={() => run(() => session.moveIdentity(person.id, 1), () => {}, '인물 순서를 바꿨습니다.')}><span aria-hidden="true">↓</span></button></div>{/if}
                        </div>
                        {#if isOpen}
                            <div class="children">
                                {#each person.outfits.slice(0, outfitLimits[person.id] ?? 8) as item (`${item.shared}:${item.outfit.id}`)}
                                    <div class="row outfit-row" class:selected={draft?.kind === 'outfit' && draft.id === item.outfit.id && draft.shared === item.shared} data-painter-outfit={item.outfit.id}>
                                        <button type="button" class="row-name" disabled={locked} aria-label={`${item.outfit.name} 의상 편집`} aria-pressed={draft?.kind === 'outfit' && draft.id === item.outfit.id && draft.shared === item.shared} onclick={() => navigate(() => selectOutfit(item))}><span>{item.outfit.name}</span><span class="hint">{item.shared ? '봇 공용' : '현재 챗'}</span></button>
                                        <div class="reorder"><button type="button" class="icon-button" aria-label={`${item.outfit.name} 위로`} title="같은 저장 범위에서 위로" disabled={locked || outfitBoundary(item, -1)} onclick={() => run(() => session.moveOutfit(item.outfit.id, item.shared, -1), () => {}, '의상 순서를 바꿨습니다.')}><span aria-hidden="true">↑</span></button><button type="button" class="icon-button" aria-label={`${item.outfit.name} 아래로`} title="같은 저장 범위에서 아래로" disabled={locked || outfitBoundary(item, 1)} onclick={() => run(() => session.moveOutfit(item.outfit.id, item.shared, 1), () => {}, '의상 순서를 바꿨습니다.')}><span aria-hidden="true">↓</span></button></div>
                                    </div>
                                {:else}<p class="hint empty">{query || scope !== 'all' ? '조건에 맞는 의상이 없습니다.' : '저장된 의상이 없습니다.'}</p>{/each}
                                {#if person.outfits.length > (outfitLimits[person.id] ?? 8)}<button type="button" class="text-button" onclick={() => outfitLimits[person.id] = (outfitLimits[person.id] ?? 8) + 8}>의상 더 보기 ({person.outfits.length - (outfitLimits[person.id] ?? 8)}개)</button>{/if}
                            </div>
                        {/if}
                    </section>
                {:else}<p class="hint empty">{query || scope !== 'all' ? '검색 결과가 없습니다. 검색어나 저장 범위를 바꿔 주세요.' : '새 인물을 등록하고 외형과 의상을 저장하세요.'}</p>{/each}
                {#if folders.length > personLimit}<button type="button" class="text-button" onclick={() => personLimit += 12}>인물 더 보기 ({folders.length - personLimit}명)</button>{/if}
            </nav>
            <div class="editor-pane">
                {#if draft}
                    <div class="editor-heading"><h3>{draft.kind === 'identity' ? (draft.exists ? '기본 외형' : '새 인물') : (draft.exists ? '의상 편집' : '새 의상')}</h3><span class="hint">{draft.kind === 'identity' ? '봇 공용' : owner?.name}{dirty ? ' / 저장하지 않음' : ''}</span>{#if draft.subjectId}<button type="button" class="text-button" disabled={locked} onclick={() => navigate(() => setEditor(emptyEditor('outfit', draft!.subjectId)))}>새 의상</button>{/if}</div>
                    <fieldset disabled={locked} data-preset-editor>
                        {#if draft.kind === 'identity'}
                            <label>이름<input aria-label="인물 이름" maxlength="160" bind:value={draft.name} /></label>
                            <label>별칭 <span class="hint">쉼표로 구분</span><input aria-label="인물 별칭" bind:value={draft.aliases} /></label>
                            <label>기본 외형<textarea aria-label="기본 외형" rows="6" bind:value={draft.appearance} placeholder="머리색, 눈색, 체형 등"></textarea></label>
                            <p class="hint">같은 봇의 모든 챗에서 사용할 수 있습니다. 새 이름으로 저장하면 외형과 별칭만 복사하며, 의상은 원래 인물에 남습니다.</p>
                        {:else}
                            <label>이름<input aria-label="의상 이름" maxlength="160" bind:value={draft.name} /></label>
                            <label>의상 프롬프트<textarea aria-label="의상 프롬프트" rows="6" bind:value={draft.clothing} placeholder="의상, 색상, 소재, 장신구 등"></textarea></label>
                            <label>의상 상태 <span class="hint">선택 사항</span><textarea aria-label="의상 상태" rows="2" bind:value={draft.state} placeholder="젖음, 찢어짐 등"></textarea></label>
                            <label>{draft.exists ? '복사할 저장 범위' : '저장 범위'}<select aria-label={draft.exists ? '복사할 저장 범위' : '새 의상 저장 범위'} value={draft.targetShared ? 'shared' : 'local'} onchange={event => { if (draft) draft.targetShared = event.currentTarget.value === 'shared' }}><option value="local">현재 챗</option><option value="shared">봇 공용</option></select></label>
                            <p class="hint">{draft.exists ? `덮어쓰기는 원본(${draft.shared ? '봇 공용' : '현재 챗'})을 수정합니다. 이름이나 저장 범위를 바꾸면 별도 프리셋으로 저장할 수 있습니다.` : '현재 챗에서만 쓰거나, 같은 봇의 모든 챗에서 사용할 수 있습니다.'}</p>
                        {/if}
                    </fieldset>
                    <div class="save-bar">
                        {#if draft.exists}<button type="button" class="primary" disabled={locked || !valid || !dirty} onclick={() => save(false)}>덮어쓰기</button><button type="button" disabled={locked || !canCopy} title={!canCopy ? '다른 이름을 입력해 주세요. 의상은 저장 범위를 바꿔 복사할 수도 있습니다.' : undefined} onclick={() => save(true)}>새 이름으로 저장</button>
                        {:else}<button type="button" class="primary" disabled={locked || !valid} onclick={() => save(!draft!.id)}>저장</button>{/if}
                        <button type="button" disabled={locked || !dirty} onclick={() => navigate(resetEditor)}>되돌리기</button>
                        {#if draft.exists}<button type="button" class="delete-button" disabled={locked} onclick={() => { deleting = true; pendingAction = null }}>삭제</button>{/if}
                    </div>
                    {#if deleting}
                        <div class="confirmation" role="alert">
                            <p>{#if draft.kind === 'identity'}「{draft.originalName}」의 외형과 이 봇의 모든 챗에 저장한 이 인물의 의상 프리셋을 삭제합니다.{:else}「{draft.originalName}」({draft.shared ? '봇 공용' : '현재 챗'}) 의상 프리셋을 삭제합니다.{/if} 기존 프롬프트와 삽화는 유지됩니다.{dirty ? ' 저장하지 않은 편집 내용도 버립니다.' : ''}</p>
                            <div class="actions"><button type="button" class="delete-button" disabled={locked} onclick={remove}>삭제 확인</button><button type="button" disabled={locked} onclick={() => deleting = false}>삭제 취소</button></div>
                        </div>
                    {/if}
                {:else}<div class="editor-empty"><h3>인물별로 외형과 의상을 정리하세요</h3><p class="hint">새 인물을 등록한 뒤 해당 인물의 의상을 추가할 수 있습니다.</p></div>{/if}
                <p class:error={failed} class="feedback" role="status" aria-live="polite">{busy ? '저장 중…' : feedback}</p>
            </div>
        </div>
    </div>
</section>

<style>
    .presets { container-type: inline-size; min-width: 0; color: var(--color-textcolor); border: 1px solid var(--color-darkborderc); border-radius: .5rem; background: var(--color-darkbg); }
    .presets.embedded { display: flex; flex-direction: column; height: 100%; min-height: 0; border: 0; background: transparent; }
    .presets.embedded > .content { flex: 1; min-height: 0; padding: 0; }
    .presets-heading { padding: .65rem; font-weight: 600; }
    .content { display: flex; flex-direction: column; gap: .65rem; padding: .65rem; min-width: 0; }
    .toolbar { display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; }
    .toolbar .search { flex: 1; min-width: 10rem; }
    label { display: flex; flex-direction: column; gap: .25rem; font-size: .82rem; min-width: 0; }
    input, select, textarea { width: 100%; min-width: 0; border: 1px solid var(--color-darkborderc); background: var(--color-bgcolor); color: var(--color-textcolor); border-radius: .3rem; padding: .45rem .55rem; }
    input, select { min-height: 2.15rem; }
    textarea { font: inherit; line-height: 1.5; resize: vertical; }
    button { min-height: 2.1rem; border: 1px solid var(--color-darkborderc); border-radius: .3rem; padding: .35rem .65rem; font-size: .82rem; overflow-wrap: anywhere; }
    button:hover:not(:disabled) { background: var(--color-darkbutton); }
    button:disabled, fieldset:disabled { opacity: .55; }
    button:disabled { cursor: default; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    .workspace { display: grid; grid-template-columns: minmax(15rem, .8fr) minmax(0, 1.4fr); min-height: 23rem; gap: 1rem; }
    .embedded .workspace { flex: 1; min-height: 0; grid-template-rows: minmax(0, 1fr); }
    .library { overflow: auto; max-height: min(62vh, 40rem); min-width: 0; padding: .15rem .35rem .15rem .15rem; scrollbar-gutter: stable; border-right: 1px solid var(--color-darkborderc); }
    .embedded .library, .embedded .editor-pane { max-height: none; }
    .person + .person { margin-top: .15rem; }
    .row { display: flex; align-items: center; gap: .15rem; border-radius: .3rem; min-width: 0; }
    .row.selected { background: var(--color-selected); }
    .row-name { display: flex; flex: 1; flex-direction: column; min-width: 0; text-align: left; border: 0; padding: .35rem; gap: .1rem; }
    .row-name > * { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-name strong { font-weight: 600; }
    .icon-button { flex-shrink: 0; display: grid; place-items: center; width: 1.7rem; min-height: 1.8rem; padding: 0; border-color: transparent; }
    .reorder { display: flex; flex-shrink: 0; }
    .children { margin: .15rem 0 .3rem .9rem; padding-left: .5rem; border-left: 1px solid var(--color-darkborderc); }
    .outfit-row .row-name { font-size: .8rem; }
    .editor-pane { min-width: 0; overflow: auto; max-height: min(62vh, 40rem); padding: .15rem; scrollbar-gutter: stable; }
    .editor-heading { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; padding-bottom: .55rem; }
    h3 { font-size: .95rem; font-weight: 600; margin: 0; }
    .editor-heading > button { margin-left: auto; }
    fieldset { border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: .65rem; }
    .hint, .feedback { color: var(--color-textcolor2); font-size: .75rem; line-height: 1.5; overflow-wrap: anywhere; }
    .save-bar, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: .35rem; }
    .save-bar { margin-top: .75rem; padding-top: .65rem; border-top: 1px solid var(--color-darkborderc); }
    .primary { background: var(--color-primary); color: var(--color-accenttext); border-color: var(--color-primary); }
    .delete-button { color: var(--color-danger); }
    .save-bar > .delete-button { margin-left: auto; }
    .text-button { border-color: transparent; padding: .3rem .4rem; }
    .confirmation { padding: .65rem; background: var(--color-bgcolor); border: 1px solid var(--color-darkborderc); border-radius: .3rem; font-size: .82rem; line-height: 1.5; }
    .confirmation p { margin: 0 0 .5rem; }
    .editor-pane > .confirmation { margin-top: .65rem; }
    .feedback { margin-top: .55rem; }
    .feedback:empty { display: none; }
    .feedback.error { color: var(--color-danger); }
    .filter-note { display: flex; gap: .5rem; align-items: center; }
    .empty { padding: .4rem; }
    .editor-empty { padding: 1.2rem .2rem; }
    @container (max-width: 650px) {
        .workspace { grid-template-columns: minmax(0, 1fr); gap: .8rem; min-height: 0; }
        .embedded .workspace { display: flex; flex-direction: column; overflow: auto; }
        .library { max-height: 15rem; border-right: 0; border-bottom: 1px solid var(--color-darkborderc); padding-bottom: .5rem; }
        .embedded .library { flex-shrink: 0; max-height: 15rem; }
        .editor-pane, .embedded .editor-pane { flex-shrink: 0; max-height: none; overflow: visible; }
    }
    @media (pointer: coarse) { button { min-height: 2.75rem; } .icon-button { width: 2.3rem; min-height: 2.75rem; } }
</style>
