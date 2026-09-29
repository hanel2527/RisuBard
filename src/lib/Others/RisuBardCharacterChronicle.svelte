<script lang="ts">
    import { buildCharacterChronicle, chroniclePage } from 'src/ts/risubard/characterChronicle'
    import { normalizeWikiLinkKey, type WikiDocument } from 'src/ts/risubard/wikiLink'
    import type { HistoricalSourceMessage } from 'src/ts/risubard/historicalSourceRecall'
    import type { StorySourceRef } from 'src/ts/risubard/storySoFar'

    interface Props {
        documents: readonly WikiDocument[]
        messages?: readonly HistoricalSourceMessage[]
        ignoreOocTurns?: boolean
        onNavigate?: (source: StorySourceRef) => void
        onEdit?: (documentId: string) => void
    }
    let { documents, messages, ignoreOocTurns = true, onNavigate, onEdit }: Props = $props()
    let search = $state('')
    let selectedId = $state('')
    let pageIndex = $state(0)
    let characters = $derived(documents.filter(d => d.type === 'character'
        && d.status === 'active' && d.contextMode !== 'never'))
    let options = $derived(characters.filter(d => [d.title, ...(d.aliases ?? [])]
        .some(name => normalizeWikiLinkKey(name).includes(normalizeWikiLinkKey(search)))))
    let selected = $derived(options.find(d => d.id === selectedId) ?? options[0])
    let chronicle = $derived(buildCharacterChronicle(documents, selected?.id ?? '', messages, ignoreOocTurns))
    let page = $derived(chroniclePage(chronicle.entries, pageIndex))

    $effect(() => {
        selected?.id
        pageIndex = 0
    })
</script>

<section class="chronicle" data-character-chronicle aria-label="인물 연대기">
    <header>
        <h2>인물 연대기</h2>
        <p>현재 위키에서 인물과 명시적으로 연결된 사건을 기록 순서로 읽습니다. 언급은 참여나 지식 습득을 뜻하지 않으며, 모든 행적이 추출된 기록은 아닙니다.</p>
    </header>
    <div class="filters">
        <label>인물 검색
            <input type="search" aria-label="인물 이름 또는 별칭 검색" bind:value={search} placeholder="이름 또는 별칭" />
        </label>
        <label>인물 선택
            <select aria-label="연대기 인물 선택" value={selected?.id ?? ''}
                disabled={options.length === 0} onchange={(event) => selectedId = event.currentTarget.value}>
                {#each options as character (character.id)}
                    <option value={character.id}>{character.title}</option>
                {/each}
            </select>
        </label>
    </div>
    {#if characters.length === 0}
        <p class="empty">등록된 인물이 없습니다. 작업 공간에서 인물 문서를 확인해 주세요.</p>
    {:else if !selected}
        <p class="empty">검색에 맞는 인물이 없습니다. 이름이나 별칭을 바꿔 검색해 주세요.</p>
    {:else}
        <div class="ledger-heading">
            <h3>{selected.title}</h3>
            <button type="button" disabled={!onEdit} onclick={() => onEdit?.(selected.id)}>인물 문서 열기</button>
        </div>
        <p class="record-count" aria-live="polite">연결된 사건 {chronicle.entries.length.toLocaleString()}개</p>
        {#if chronicle.ambiguousCount || chronicle.unlinkedCount}
            <p class="coverage" data-chronicle-coverage>
                {#if chronicle.ambiguousCount}이 인물과의 연결이 모호한 사건 {chronicle.ambiguousCount}개가 있습니다. {/if}
                {#if chronicle.unlinkedCount}인물 연결이 확인되지 않은 사건 {chronicle.unlinkedCount}개는 목록에 포함하지 않았습니다.{/if}
                작업 공간에서 사건의 인물 링크를 확인해 주세요.
            </p>
        {/if}
        {#if page.entries.length === 0}
            <p class="empty">연결된 사건이 없습니다. 사건이나 인물 문서에 정확한 위키 링크가 있어야 표시됩니다.</p>
        {:else}
            <nav aria-label="연대기 페이지" class="pagination">
                <button type="button" aria-label="이전 연대기 페이지" disabled={page.page === 0} onclick={() => pageIndex = page.page - 1}>이전</button>
                <span>{page.page + 1} / {page.pageCount}</span>
                <button type="button" aria-label="다음 연대기 페이지" disabled={page.page + 1 === page.pageCount} onclick={() => pageIndex = page.page + 1}>다음</button>
                <label>페이지 이동 <input type="number" aria-label="연대기 페이지 이동" min="1" max={page.pageCount} value={page.page + 1}
                    onchange={(event) => pageIndex = Number(event.currentTarget.value) - 1} /></label>
            </nav>
            <ol start={page.page * 20 + 1}>
                {#each page.entries as entry (entry.id)}
                    <li data-chronicle-entry={entry.id}>
                        <div class="entry-meta"><span>연결된 기록</span><span>기록 시각 {entry.recorded.slice(0, 19).replace('T', ' ')}</span></div>
                        <h4>{entry.title.slice(0, 180)}</h4>
                        {#if entry.storyTime}<p class="story-time">작중 시간 {entry.storyTime.slice(0, 240)}</p>{/if}
                        <p class="excerpt">{entry.excerpt || '미리보기가 없습니다. 사건 문서를 열어 확인해 주세요.'}</p>
                        <div class="entry-actions">
                            <button type="button" data-chronicle-edit disabled={!onEdit} onclick={() => onEdit?.(entry.id)}>사건 보기와 편집</button>
                            <button type="button" data-chronicle-source disabled={!onNavigate || !entry.source.messageIds.length}
                                onclick={() => onNavigate?.(entry.source)}>원문으로 이동</button>
                        </div>
                        {#if !entry.source.messageIds.length || entry.missingSourceCount}
                            <p class="source-note">{entry.missingSourceCount ? `현재 챗에서 확인할 수 없는 원문 출처 ${entry.missingSourceCount}개` : '원문 출처 없음'}</p>
                        {/if}
                    </li>
                {/each}
            </ol>
        {/if}
    {/if}
</section>

<style>
    .chronicle { height: 100%; overflow: auto; padding: clamp(1rem, 3vw, 2rem); background: var(--risu-theme-bgcolor); color: var(--risu-theme-textcolor); scrollbar-color: var(--risu-theme-borderc) transparent; }
    header, .filters, .ledger-heading, .record-count, .coverage, .pagination, ol, .empty { max-width: 48rem; margin-left: auto; margin-right: auto; }
    h2 { margin: 0 0 .6rem; font-size: 1.4rem; font-weight: 600; }
    header p, .coverage, .source-note, .record-count { color: var(--risu-theme-textcolor2); font-size: .85rem; line-height: 1.6; }
    .filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .8rem; margin-top: 1.3rem; margin-bottom: 1.5rem; }
    label { display: flex; flex-direction: column; gap: .35rem; min-width: 0; font-size: .85rem; }
    input, select, button { border: 1px solid var(--risu-theme-borderc); border-radius: .3rem; background: var(--risu-theme-darkbg); color: var(--risu-theme-textcolor); font: inherit; }
    input, select { min-width: 0; width: 100%; padding: .55rem; caret-color: var(--risu-theme-primary); }
    input::placeholder { color: var(--risu-theme-textcolor2); }
    button { padding: .5rem .7rem; cursor: pointer; font-size: .82rem; }
    button:hover:not(:disabled) { border-color: var(--risu-theme-primary); }
    button:disabled { opacity: .55; cursor: default; }
    :is(input, select, button):focus-visible { outline: 2px solid var(--risu-theme-primary); outline-offset: 2px; }
    .ledger-heading { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; justify-content: space-between; }
    h3 { margin: 0; min-width: 0; font-size: 1.1rem; overflow-wrap: anywhere; }
    .record-count { margin-top: .45rem; margin-bottom: .5rem; }
    .coverage { padding: .7rem 0; border-top: 1px solid var(--risu-theme-borderc); }
    .pagination { display: flex; align-items: center; flex-wrap: wrap; gap: .65rem; margin-top: 1rem; margin-bottom: 1rem; font-variant-numeric: tabular-nums; font-size: .85rem; }
    .pagination label { flex-direction: row; align-items: center; margin-left: auto; }
    .pagination input { width: 5rem; }
    ol { list-style: none; padding: 0; }
    li { padding: 1.15rem 0; border-top: 1px solid var(--risu-theme-borderc); overflow-wrap: anywhere; }
    .entry-meta { display: flex; flex-wrap: wrap; gap: .3rem 1rem; font-size: .75rem; color: var(--risu-theme-textcolor2); }
    h4 { margin: .5rem 0; font-size: 1rem; font-weight: 600; }
    .excerpt { margin: .6rem 0 .9rem; font-size: .92rem; line-height: 1.75; }
    .story-time { font-size: .82rem; color: var(--risu-theme-textcolor2); }
    .entry-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .source-note { margin: .55rem 0 0; }
    .empty { padding: 1.5rem 0; color: var(--risu-theme-textcolor2); line-height: 1.7; }
    @media (max-width: 480px) { .filters { grid-template-columns: 1fr; } .pagination label { margin-left: 0; } }
</style>
