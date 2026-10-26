<script lang="ts">
    import { onDestroy, tick } from 'svelte'
    import { alertConfirm, alertInput } from 'src/ts/alert'
    import type { Chat } from 'src/ts/storage/database.svelte'
    import type { StoryBackupSummary, StoryHistoryState } from 'src/ts/risubard/storyHistoryTypes'
    import { captureStoryChat, previewStoryBackup, quickStorySave, renameStoryBackup, retryStoryWiki, keepStoryWiki } from 'src/ts/risubard/storyHistory'
    import type { StoryBackupPreview } from 'src/ts/risubard/storyHistory'
    import ShButton from '../UI/GUI/ShButton.svelte'

    interface Props {
        characterId: string
        chat: Chat
        history: StoryHistoryState
        onRefresh(): Promise<void>
        onLoad(backupId: string, asNewChat: boolean): Promise<void>
        onRollback(): Promise<void>
    }
    let { characterId, chat, history, onRefresh, onLoad, onRollback }: Props = $props()
    let selectedId = $state('')
    let collapsed = $state<Set<string>>(new Set())
    let page = $state(0)
    let busy = $state('')
    let error = $state('')
    let preview = $state<StoryBackupPreview | null>(null)
    let previewLoading = $state(false)
    let documentPath = $state('')
    let treeElement: HTMLDivElement | undefined
    let previewSequence = 0
    let active = true
    onDestroy(() => { active = false; ++previewSequence })
    const pageSize = 100
    const kinds: Record<StoryBackupSummary['kind'], string> = { working: '미확정 채팅', 'chat-edit': '채팅 편집', manual: '수동 북마크', turn: '위키 확정', 'wiki-edit': '위키 수정', import: '가져옴 · bind 불명' }
    const nodes = $derived(new Map(history.backups.map((backup) => [backup.id, backup])))
    const children = $derived.by(() => {
        const result = new Map<string | null, StoryBackupSummary[]>()
        for (const backup of history.backups) {
            const parent = backup.parentId && nodes.has(backup.parentId) ? backup.parentId : null
            const siblings = result.get(parent) ?? []
            siblings.push(backup)
            result.set(parent, siblings)
        }
        for (const siblings of result.values()) siblings.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        return result
    })
    const rows = $derived.by(() => {
        const result: Array<{ backup: StoryBackupSummary; depth: number; position: number; siblings: number }> = []
        const roots = children.get(null) ?? []
        const stack = roots.map((backup, index) => ({ backup, depth: 1, position: index + 1, siblings: roots.length })).reverse()
        const visited = new Set<string>()
        while (stack.length) {
            const row = stack.pop()!
            if (visited.has(row.backup.id)) continue
            visited.add(row.backup.id)
            result.push(row)
            if (collapsed.has(row.backup.id)) continue
            const descendants = children.get(row.backup.id) ?? []
            for (let index = descendants.length - 1; index >= 0; index--) stack.push({ backup: descendants[index], depth: row.depth + 1, position: index + 1, siblings: descendants.length })
        }
        return result
    })
    const pageCount = $derived(Math.max(1, Math.ceil(rows.length / pageSize)))
    const activePage = $derived(Math.min(page, pageCount - 1))
    const visibleRows = $derived(rows.slice(activePage * pageSize, (activePage + 1) * pageSize))
    const selected = $derived(nodes.get(selectedId))
    const tips = $derived(new Set(history.branches.map((branch) => branch.tipId)))
    const locked = $derived(Boolean(busy) || Boolean(history.pendingCheckout) || chat.isStreaming === true || Boolean(chat._placeholder) || !chat.id)
    const pending = $derived(history.pendingWiki)
    const selectedDocument = $derived(preview?.documents.find((document) => document.path === documentPath))

    function toggle(id: string): void {
        const next = new Set(collapsed)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        collapsed = next
    }
    async function focusRow(index: number): Promise<void> {
        const row = rows[Math.max(0, Math.min(rows.length - 1, index))]
        if (!row) return
        selectedId = row.backup.id
        page = Math.floor(Math.max(0, index) / pageSize)
        await tick()
        const item = Array.from(treeElement?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? []).find((element) => element.dataset.backupId === row.backup.id)
        item?.focus()
    }
    function treeKey(event: KeyboardEvent, backup: StoryBackupSummary): void {
        const index = rows.findIndex((row) => row.backup.id === backup.id)
        if (event.key === 'ArrowDown') { event.preventDefault(); void focusRow(index + 1) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); void focusRow(index - 1) }
        else if (event.key === 'Home') { event.preventDefault(); void focusRow(0) }
        else if (event.key === 'End') { event.preventDefault(); void focusRow(rows.length - 1) }
        else if (event.key === 'ArrowRight' && children.has(backup.id)) {
            event.preventDefault()
            if (collapsed.has(backup.id)) toggle(backup.id)
            else void focusRow(index + 1)
        } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            if (children.has(backup.id) && !collapsed.has(backup.id)) toggle(backup.id)
            else if (backup.parentId) void focusRow(rows.findIndex((row) => row.backup.id === backup.parentId))
        }
    }
    async function run(label: string, action: () => Promise<unknown>): Promise<void> {
        if (!active || busy) return
        busy = label
        error = ''
        try { await action(); if (active) await onRefresh() }
        catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
        finally { busy = '' }
    }
    async function rename(): Promise<void> {
        if (!selected) return
        const id = selected.id
        const name = await alertInput('이력 이름 / 북마크', [], selected.name ?? '')
        if (!active || name === null || name === undefined) return
        if (!name.trim()) { error = '이력 이름을 입력해 주세요.'; return }
        await run('이름 저장 중…', () => renameStoryBackup(characterId, chat.id!, id, name.trim()))
    }
    async function load(asNewChat: boolean, fork = false): Promise<void> {
        if (!selected || locked || pending) return
        const id = selected.id
        if (!await alertConfirm(asNewChat ? '선택한 채팅·위키·변수를 새 채팅으로 복사할까요?' : '현재 작업을 이력에 보존한 뒤 선택한 채팅·위키·변수로 이동할까요? 이후 첫 변경은 같은 채팅의 새 분기로 보존됩니다.')) return
        if (!active) return
        await run(fork ? '분기 위치로 이동 중…' : '불러오는 중…', () => onLoad(id, asNewChat))
    }
    $effect(() => {
        if (!nodes.has(selectedId)) {
            selectedId = history.headId ?? history.backups[0]?.id ?? ''
            const index = rows.findIndex((row) => row.backup.id === selectedId)
            page = Math.floor(Math.max(0, index) / pageSize)
        }
    })
    $effect(() => {
        const id = selectedId
        const character = characterId
        const chatId = chat.id!
        const sequence = ++previewSequence
        preview = null
        documentPath = ''
        previewLoading = Boolean(id)
        if (id) void previewStoryBackup(character, chatId, id).then((result) => {
            if (sequence !== previewSequence) return
            preview = result
            documentPath = (result.documents.find((document) =>
                !document.path.split('/').some((segment) => segment.startsWith('.')))
                ?? result.documents[0])?.path ?? ''
        }).catch((cause) => {
            if (sequence === previewSequence) error = cause instanceof Error ? cause.message : String(cause)
        }).finally(() => { if (sequence === previewSequence) previewLoading = false })
        return () => { ++previewSequence }
    })
</script>

<div class="history">
    <div class="history-toolbar" role="group" aria-label="이력 저장">
        <ShButton size="sm" disabled={locked} onclick={() => void run('수동 북마크 저장 중…', () => captureStoryChat(characterId, chat, 'manual'))}>현재 위치 북마크</ShButton>
        <ShButton size="sm" disabled={locked} onclick={() => void run('퀵 북마크 저장 중…', () => quickStorySave(characterId, chat))}>퀵 북마크 저장</ShButton>
        <ShButton size="sm" variant="outline" disabled={locked || !history.quickSaveId || Boolean(pending)} onclick={() => { const id = history.quickSaveId; if (id) void run('퀵로드 중…', () => onLoad(id, false)) }}>퀵로드</ShButton>
        <ShButton size="sm" variant="outline" disabled={locked || Boolean(pending)} onclick={() => void onRollback()}>모든 이력을 구형 슬롯으로 변환</ShButton>
    </div>
    <p class="history-help">모든 분기를 보관합니다. 과거를 불러온 뒤 첫 변경 시 같은 채팅 안에서 분기하며 원래 미래는 남습니다. 채팅 전용 백업은 새 위키 확정이 아닙니다.</p>
    {#if pending}
        <section class="history-pending" role="status" aria-label="위키 확정 대기">
            <strong>위키 {pending.status === 'writing' ? '확정 중' : '확정 대기'} · 대상 {pending.targetMessageId}</strong>
            {#if pending.error}<p>{pending.error}</p>{/if}
            <p>채팅은 보존됩니다. 실패·취소 후에는 재시도하거나 기존 위키로 명시적으로 확정해 주세요.</p>
            <ShButton size="sm" disabled={locked} onclick={() => void run('위키 재시도 중…', async () => { if (!await retryStoryWiki(characterId, chat.id!)) throw new Error('위키 확정을 완료하지 못했습니다. 대기 상태와 오류를 확인해 주세요.') })}>재시도 / 중단된 작업 복구</ShButton>
            <ShButton size="sm" variant="outline" disabled={locked} onclick={() => void run('기존 위키로 확정 중…', async () => { if (await alertConfirm('부분 결과 대신 실패 전의 기존 위키로 이 턴을 확정할까요?')) { if (!active) return; if (!await keepStoryWiki(characterId, chat.id!)) throw new Error('기존 위키 확정을 완료하지 못했습니다.') } })}>기존 위키로 확정</ShButton>
        </section>
    {/if}
    {#if history.pendingCheckout}<p role="status">이전 불러오기 복구 작업이 대기 중입니다. 새로고침 후 복구 상태를 확인해 주세요.</p>{/if}
    {#if busy}<p role="status" aria-live="polite">{busy}</p>{/if}
    {#if error}<p role="alert" class="history-error">{error}</p>{/if}
    <div class="history-workspace">
        <section class="history-browser" aria-label="저장 이력">
            <div class="history-pagination">
                <ShButton size="sm" variant="ghost" disabled={activePage === 0} onclick={() => { page = activePage - 1 }}>이전</ShButton>
                <span>{activePage + 1} / {pageCount} · {rows.length}개 표시 / 전체 {history.backups.length}개</span>
                <ShButton size="sm" variant="ghost" disabled={activePage + 1 >= pageCount} onclick={() => { page = activePage + 1 }}>다음</ShButton>
            </div>
            <div role="tree" aria-label="채팅 및 위키 이력 트리" class="history-tree" bind:this={treeElement}>
                {#each visibleRows as row (row.backup.id)}
                    {@const backup = row.backup}
                    <div class="history-row" style={`--depth:${Math.min(row.depth - 1, 12)}`}>
                        {#if children.has(backup.id)}<button type="button" class="history-toggle" tabindex="-1" aria-label={collapsed.has(backup.id) ? '하위 이력 펼치기' : '하위 이력 접기'} onclick={() => toggle(backup.id)}>{collapsed.has(backup.id) ? '▸' : '▾'}</button>{:else}<span class="history-toggle"></span>{/if}
                        <button type="button" role="treeitem" data-backup-id={backup.id} aria-level={row.depth} aria-posinset={row.position} aria-setsize={row.siblings} aria-expanded={children.has(backup.id) ? !collapsed.has(backup.id) : undefined} aria-selected={selectedId === backup.id} aria-current={history.headId === backup.id ? 'location' : undefined} tabindex={selectedId === backup.id || (!visibleRows.some((entry) => entry.backup.id === selectedId) && row === visibleRows[0]) ? 0 : -1} class:selected={selectedId === backup.id} class="history-node" onclick={() => { selectedId = backup.id }} onkeydown={(event) => treeKey(event, backup)}>
                            <strong>{backup.name || kinds[backup.kind]} · TURN {backup.turnCount}</strong>
                            <span>{new Date(backup.createdAt).toLocaleString()} · {backup.branchId.slice(0, 8)}</span>
                            <span>{backup.kind === 'turn' || backup.kind === 'wiki-edit' ? '위키 commit' : backup.kind === 'import' ? '가져온 위키 · bind 불명' : '채팅 전용 백업 · 기존 위키 유지'}{history.headId === backup.id ? ' · 현재' : ''}{tips.has(backup.id) ? ' · branch tip' : ''}{history.quickSaveId === backup.id ? ' · QUICK' : ''}{selectedId === backup.id ? ' · 선택됨' : ''}</span>
                        </button>
                    </div>
                {/each}
                {#if !rows.length}<p>아직 저장 이력이 없습니다.</p>{/if}
            </div>
        </section>
        <aside class="history-preview" aria-label="선택한 이력 프리뷰">
            <div class="history-toolbar">
                <ShButton size="sm" disabled={!selected || locked || Boolean(pending)} onclick={() => void load(false)}>불러오기</ShButton>
                <ShButton size="sm" title="선택한 과거 위치를 불러옵니다. 첫 변경을 저장하면 같은 채팅 안에 새 분기가 생깁니다." disabled={!selected || locked || Boolean(pending)} onclick={() => void load(false, true)}>분기 위치로 불러오기</ShButton>
                <ShButton size="sm" variant="outline" disabled={!selected || locked || Boolean(pending)} onclick={() => void load(true)}>새 채팅으로 복사</ShButton>
                <ShButton size="sm" variant="ghost" disabled={!selected || locked} onclick={() => void rename()}>이름 / 북마크</ShButton>
            </div>
            {#if selected}<p class="history-meta">{selected.id}<br />부모: {selected.parentId ?? '독립 root'}<br />위키: {selected.wikiCommitId}<br />대상: {selected.anchorMessageId ?? '없음'}</p>{/if}
            {#if previewLoading}<p role="status">프리뷰 읽는 중…</p>{:else if preview}
                <h3>채팅 프리뷰</h3>
                {#if preview.chat.message.length > 80}<p>최근 80개 메시지 표시 (전체 {preview.chat.message.length}개)</p>{/if}
                {#each preview.chat.message.slice(-80) as message}<article><strong>{message.role === 'user' ? 'USER' : 'CHARACTER'}</strong><p>{message.data}</p></article>{/each}
                <h3>이 백업의 위키 문서 ({preview.documents.length})</h3>
                {#if preview.documents.length}<label>문서 <select bind:value={documentPath}>{#each preview.documents as document}<option value={document.path}>{document.path}</option>{/each}</select></label><pre>{selectedDocument?.content ?? '문서 내용을 불러오지 못했습니다.'}</pre>{:else}<p>위키 문서가 없습니다.</p>{/if}
            {/if}
        </aside>
    </div>
</div>

<style>
    .history { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: .6rem; }
    .history-toolbar { display: flex; flex-wrap: wrap; gap: .35rem; }
    .history-help, .history-meta { font-size: .75rem; color: var(--color-textcolor2); overflow-wrap: anywhere; }
    .history-error { color: var(--color-danger); }
    .history-pending { padding: .7rem; border: 1px solid var(--color-borderc); border-radius: .5rem; font-size: .8rem; }
    .history-pending p { margin: .35rem 0; overflow-wrap: anywhere; }
    .history-workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); flex: 1; min-height: 0; gap: .75rem; }
    .history-browser, .history-preview { min-height: 0; overflow: auto; border: 1px solid var(--color-darkborderc); border-radius: .5rem; padding: .5rem; }
    .history-pagination { display: flex; align-items: center; justify-content: space-between; gap: .4rem; font-size: .7rem; }
    .history-tree { padding: .4rem 0; }
    .history-row { display: flex; padding-left: calc(var(--depth) * .8rem); }
    .history-toggle { flex: 0 0 1.25rem; width: 1.25rem; align-self: start; padding-top: .6rem; }
    .history-node { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: .2rem; text-align: left; padding: .6rem; margin-bottom: .35rem; border: 1px solid var(--color-darkborderc); border-radius: .4rem; overflow-wrap: anywhere; }
    .history-node strong { font-size: .8rem; }
    .history-node span { font-size: .65rem; color: var(--color-textcolor2); }
    .history-node.selected { border-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 18%, transparent); }
    .history-node:focus-visible, .history-toggle:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    .history-preview { font-size: .78rem; }
    .history-preview h3 { margin: .8rem 0 .4rem; font-weight: bold; }
    .history-preview article { padding: .5rem; margin-bottom: .4rem; border: 1px solid var(--color-darkborderc); border-radius: .4rem; }
    .history-preview article strong { font-size: .65rem; color: var(--color-textcolor2); }
    .history-preview article p, .history-preview pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .history-preview select { width: 100%; background: var(--color-darkbg); padding: .4rem; }
    .history-preview pre { margin-top: .5rem; }
    @media (max-width: 767px) { .history-workspace { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(10rem, 1fr) minmax(10rem, 1fr); } }
</style>
