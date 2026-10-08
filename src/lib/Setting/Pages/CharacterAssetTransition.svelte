<script lang="ts">
    import { onDestroy, onMount } from 'svelte'
    import { DBState } from 'src/ts/stores.svelte'
    import { isNodeServer } from 'src/ts/platform'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { characterPackageLabel, packageStatus, refreshPackageStatus, type PackageLabel } from 'src/ts/storage/packageStatus.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'

    let characterId = $state('')
    let busy = $state(false)
    let message = $state('')
    let batchRunning = $state(false)
    let stopRequested = $state(false)
    let batchMessage = $state('')
    let batchResults = $state<{ id: string; name: string; outcome: string }[]>([])
    onDestroy(() => { stopRequested = true })
    let result = $state<{ enabled: boolean; directory: string; chats: number; assets: { enabled: boolean; copied: number; skipped: number; failed: number }; kv?: { retired: number; bytes: number }; v4?: { retired?: number; shared?: number; unverified?: number; restored?: number; failed?: number }; diagnostics: { reads: number; fallbacks: number } } | null>(null)
    const megabytes = (bytes: number) => (bytes / 1048576).toFixed(1)
    const characters = $derived(DBState.db.characters.filter(character => !character.trashTime))
    const nameCounts = $derived.by(() => {
        const counts = new Map<string, number>()
        for (const character of characters) counts.set(character.name, (counts.get(character.name) ?? 0) + 1)
        return counts
    })
    let filter = $state<'all' | PackageLabel>('all')
    const labels = $derived(new Map(characters.map(character => [character.chaId, characterPackageLabel(character.chaId)])))
    const filterOptions = $derived.by(() => {
        const count = (label: PackageLabel) => characters.filter(character => labels.get(character.chaId) === label).length
        return [
            { value: 'all' as const, label: '전체', count: characters.length },
            { value: '' as const, label: '기존 구조', count: count('') },
            { value: 'V3' as const, label: 'V3', count: count('V3') },
            { value: 'V3 일부' as const, label: 'V3 일부', count: count('V3 일부') },
            { value: 'V4' as const, label: 'V4', count: count('V4') },
        ].filter(option => option.value === 'all' || option.count > 0)
    })
    // The selected character stays listed even when the filter would hide it.
    const listedCharacters = $derived(filter === 'all' ? characters
        : characters.filter(character => labels.get(character.chaId) === filter || character.chaId === characterId))
    onMount(() => { void refreshPackageStatus() })

    async function runAll() {
        if (busy) return
        const targets = [...new Map(DBState.db.characters.filter(character => !character.trashTime)
            .map(character => [character.chaId, { id: character.chaId, name: character.name }])).values()]
        if (!targets.length) return
        busy = true
        batchRunning = true
        stopRequested = false
        batchResults = []
        result = null
        message = ''
        batchMessage = '전체 전환 준비 중'
        const active = (id: string) => DBState.db.characters.some(character => character.chaId === id && !character.trashTime)
        try {
            await forageStorage.Init()
            for (const target of targets) {
                if (stopRequested) break
                batchMessage = `처리 중 ${batchResults.length + 1}/${targets.length}: ${target.name}`
                let outcome = '삭제되어 제외'
                if (active(target.id)) {
                    try {
                        let status = await forageStorage.realStorage.characterPackageTransition(target.id, 'status')
                        if (stopRequested) break
                        if (active(target.id)) {
                            if (!status.enabled || !status.assets.enabled || status.assets.failed > 0) {
                                status = await forageStorage.realStorage.characterPackageTransition(target.id, status.enabled ? 'refresh' : 'migrate')
                                outcome = status.enabled ? '전환 완료' : 'V3 폴더 전환 미완료'
                            } else {
                                outcome = '이미 V3 사용 중'
                            }
                            if (status.assets.failed > 0) outcome = `에셋 ${status.assets.failed}개 실패: 재개 시 재검증`
                        }
                    } catch {
                        outcome = '상태 확인 또는 전환 실패: 재개 시 서버 상태를 다시 확인합니다.'
                    }
                }
                batchResults = [...batchResults, { ...target, outcome }]
            }
            batchMessage = `${stopRequested ? '전체 처리 중단' : '전체 처리 완료'} (${batchResults.length}/${targets.length}). 캐릭터별 결과를 확인해 주세요.`
        } catch {
            batchMessage = '전체 전환을 시작하지 못했습니다. 저장 연결을 확인하고 다시 시도해 주세요.'
        } finally {
            busy = false
            batchRunning = false
            void refreshPackageStatus()
        }
    }

    async function run(action: 'status' | 'migrate' | 'refresh' | 'rollback' | 'retire-kv' | 'restore-kv') {
        const id = characterId
        if (!id || busy) return
        if (!DBState.db.characters.some(character => character.chaId === id && !character.trashTime)) {
            characterId = ''
            result = null
            message = '선택한 캐릭터가 삭제되었습니다. 다른 캐릭터를 선택해 주세요.'
            return
        }
        busy = true
        result = null
        message = ''
        try {
            await forageStorage.Init()
            result = await forageStorage.realStorage.characterPackageTransition(id, action)
        } catch {
            const failure = action === 'retire-kv' ? 'V4 전환을 완료하지 못했습니다.'
                : action === 'restore-kv' ? 'V4 되돌리기를 완료하지 못했습니다.'
                : action === 'rollback' ? '기존 구조로 되돌리기를 완료하지 못했습니다.'
                : action === 'refresh' ? '폴더와 에셋 재검증을 완료하지 못했습니다.'
                : action === 'migrate' ? 'V3 전환을 완료하지 못했습니다.'
                : 'V3 전환 상태를 확인하지 못했습니다.'
            message = `${failure} 저장이 끝난 뒤 다시 시도해 주세요. 복구 가능한 원본은 유지됩니다.`
            if (action !== 'status') {
                try {
                    result = await forageStorage.realStorage.characterPackageTransition(id, 'status')
                } catch {
                    message += ' 현재 상태도 확인하지 못했습니다.'
                }
            }
        } finally {
            busy = false
            if (action !== 'status') void refreshPackageStatus()
        }
    }
</script>

{#if isNodeServer}
    <section class="asset-pilot">
        <h2>캐릭터 V3 저장 구조 전환 (시험 기능)</h2>
        <p>선택한 캐릭터 하나의 본문, 채팅과 전용 에셋을 이름 기반 폴더로 전환합니다. 다른 캐릭터와 기존 백업 형식은 바뀌지 않습니다. 되돌릴 때는 전환 뒤 변경까지 최신 상태로 ID 폴더에 복귀합니다.</p>
        <p>전체 전환은 현재 삭제되지 않은 캐릭터를 하나씩 처리합니다. 시작 전 백업을 보관해 주세요. 중단하거나 이 화면을 나가면 진행 중 요청까지만 처리하며, 다시 실행하면 서버 상태를 확인해 남은 전환과 실패한 에셋 검증을 이어갑니다. 공유 에셋, 바드위키와 모듈의 위치는 유지됩니다.</p>
        <div class="actions">
            <ShButton variant="primary" onclick={runAll} disabled={busy || !characters.length}>전체 캐릭터 V3 전환 / 재개</ShButton>
            {#if batchRunning}
                <ShButton variant="outline" onclick={() => { stopRequested = true }} disabled={stopRequested}>{stopRequested ? '중단 대기 중' : '중단'}</ShButton>
            {/if}
        </div>
        <div role="status" aria-live="polite">{batchMessage}</div>
        {#if batchResults.length}
            <ul>
                {#each batchResults as entry (entry.id)}
                    <li>{entry.name} ({entry.id}): {entry.outcome}</li>
                {/each}
            </ul>
        {/if}
        {#if packageStatus.loaded}
            <div class="filters" role="group" aria-label="저장 구조로 걸러 보기">
                {#each filterOptions as option (option.value)}
                    <button type="button" class="filter" aria-pressed={filter === option.value} onclick={() => { filter = option.value }}>{option.label} {option.count}</button>
                {/each}
            </div>
        {/if}
        <label for="asset-transition-character">전환할 캐릭터</label>
        <select id="asset-transition-character" bind:value={characterId} disabled={busy} onchange={() => { result = null; message = '' }}>
            <option value="">캐릭터를 선택해 주세요</option>
            {#each listedCharacters as character (character.chaId)}
                <option value={character.chaId}>{character.name}{(nameCounts.get(character.name) ?? 0) > 1 ? ` (${character.chaId})` : ''}{labels.get(character.chaId) ? ` [${labels.get(character.chaId)}]` : ''}</option>
            {/each}
        </select>
        <div class="actions">
            <ShButton variant="outline" onclick={() => run('status')} disabled={!characterId || busy}>상태 확인</ShButton>
            <ShButton variant="primary" onclick={() => run(result?.enabled ? 'refresh' : 'migrate')} disabled={!characterId || busy}>{busy ? '처리 중…' : (result?.enabled ? '폴더와 에셋 재검증' : 'V3 구조로 전환')}</ShButton>
            <ShButton variant="outline" onclick={() => run('rollback')} disabled={!characterId || busy || (result?.enabled === false && !result.assets.enabled)}>기존 구조로 되돌리기</ShButton>
        </div>
        <div role="status" aria-live="polite">
            {#if result}
                <p>{result.enabled ? `V3 구조 사용 중: ${result.directory} 폴더, 채팅 ${result.chats}개` : result.assets.enabled ? 'V3 폴더 전환 미완료: 기존 ID 폴더를 사용하며 에셋 복사본 읽기만 활성화되어 있습니다.' : '기존 ID 폴더와 KV 에셋 읽기를 사용합니다.'}</p>
                <p>에셋 복사 검증 {result.assets.copied}개 / 공유 제외 {result.assets.skipped}개 / 실패 {result.assets.failed}개</p>
                <p>이번 서버 실행 전체: V3 읽기 {result.diagnostics.reads}회 / KV 폴백 {result.diagnostics.fallbacks}회</p>
            {/if}
            {#if message}<p>{message}</p>{/if}
        </div>
        <h3>V4 시험: 에셋을 KV 목록에서 빼기</h3>
        <p>V3 구조를 쓰는 캐릭터의 전용 에셋을 공용 저장소(KV) 목록에서 빼고 캐릭터 폴더의 복사본으로 읽습니다. 목록이 작아져 에셋 저장과 가져오기가 가벼워집니다. 원본 파일은 지우지 않고 보관하므로 V4 되돌리기를 누르면 바로 복구됩니다. 다른 캐릭터나 설정과 같이 쓰는 에셋과 폴더 복사본이 원본과 다른 에셋은 KV에 그대로 둡니다.</p>
        <p>이전 버전 앱으로 돌아가기 전에는 반드시 V4 되돌리기를 눌러 주세요. 이전 버전은 목록에서 뺀 에셋을 찾지 못합니다.</p>
        <div class="actions">
            <ShButton variant="primary" onclick={() => run('retire-kv')} disabled={!characterId || busy || !result?.enabled}>V4로 전환</ShButton>
            <ShButton variant="outline" onclick={() => run('restore-kv')} disabled={!characterId || busy || !result?.kv?.retired}>V4 되돌리기</ShButton>
        </div>
        <div role="status" aria-live="polite">
            {#if !result}
                <p>캐릭터를 고르고 상태 확인을 누르면, V3 구조를 쓰는 캐릭터에서 V4로 전환할 수 있습니다.</p>
            {:else}
                <p>{result.kv?.retired ? `V4 사용 중: KV 목록에서 뺀 에셋 ${result.kv.retired}개 (${megabytes(result.kv.bytes)}MB)` : result.enabled ? 'V4 미사용: 에셋이 모두 KV 목록에 있습니다.' : 'V3 구조로 먼저 전환해야 V4로 전환할 수 있습니다.'}</p>
                {#if result.v4?.retired !== undefined}
                    <p>이번 전환: {result.v4.retired}개 이동 / 공유 에셋이라 유지 {result.v4.shared ?? 0}개 / 복사본 검증 실패로 유지 {result.v4.unverified ?? 0}개</p>
                {/if}
                {#if result.v4?.restored !== undefined}
                    <p>되돌리기: {result.v4.restored}개를 KV 목록에 복원{result.v4.failed ? ` / 복원 실패 ${result.v4.failed}개 (보관 목록에 그대로 둠)` : ''}</p>
                {/if}
            {/if}
        </div>
    </section>
{/if}

<style>
    .asset-pilot { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; gap: .7rem; padding: 1rem; background: var(--settings-surface); border: 1px solid var(--settings-border); border-radius: var(--settings-radius); }
    h2 { font-size: 1rem; color: var(--color-textcolor); }
    h3 { margin-top: .5rem; font-size: .95rem; color: var(--color-textcolor); }
    p { color: var(--color-textcolor2); line-height: 1.5; }
    select { padding: .6rem; color: var(--color-textcolor); background: var(--color-darkbg); border: 1px solid var(--settings-border); border-radius: .4rem; max-width: 100%; }
    .actions, .filters { display: flex; flex-wrap: wrap; gap: .5rem; }
    .filter { padding: .3rem .65rem; font-size: .85rem; color: var(--color-textcolor2); background: var(--color-darkbg); border: 1px solid var(--settings-border); border-radius: 999px; }
    .filter[aria-pressed='true'] { color: var(--color-textcolor); border-color: var(--color-borderc); background: var(--color-selected); }
    .filter:focus-visible { outline: 2px solid var(--color-warning); outline-offset: 2px; }
</style>
