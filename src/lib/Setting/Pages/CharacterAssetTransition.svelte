<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte'
    import { isNodeServer } from 'src/ts/platform'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'

    let characterId = $state('')
    let busy = $state(false)
    let message = $state('')
    let result = $state<{ enabled: boolean; directory: string; chats: number; assets: { enabled: boolean; copied: number; skipped: number; failed: number }; diagnostics: { reads: number; fallbacks: number } } | null>(null)
    const characters = $derived(DBState.db.characters.filter(character => !character.trashTime))
    const nameCounts = $derived.by(() => {
        const counts = new Map<string, number>()
        for (const character of characters) counts.set(character.name, (counts.get(character.name) ?? 0) + 1)
        return counts
    })

    async function run(action: 'status' | 'migrate' | 'refresh' | 'rollback') {
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
            const failure = action === 'rollback' ? '기존 구조로 되돌리기를 완료하지 못했습니다.'
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
        } finally { busy = false }
    }
</script>

{#if isNodeServer}
    <section class="asset-pilot">
        <h2>캐릭터 V3 저장 구조 전환 (시험 기능)</h2>
        <p>선택한 캐릭터 하나의 본문, 채팅과 전용 에셋을 이름 기반 폴더로 전환합니다. 다른 캐릭터와 기존 백업 형식은 바뀌지 않습니다. 되돌릴 때는 전환 뒤 변경까지 최신 상태로 ID 폴더에 복귀합니다.</p>
        <label for="asset-transition-character">전환할 캐릭터</label>
        <select id="asset-transition-character" bind:value={characterId} disabled={busy} onchange={() => { result = null; message = '' }}>
            <option value="">캐릭터를 선택해 주세요</option>
            {#each characters as character (character.chaId)}
                <option value={character.chaId}>{character.name}{(nameCounts.get(character.name) ?? 0) > 1 ? ` (${character.chaId})` : ''}</option>
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
    </section>
{/if}

<style>
    .asset-pilot { display: grid; gap: .7rem; padding: 1rem; background: var(--settings-surface); border: 1px solid var(--settings-border); border-radius: var(--settings-radius); }
    h2 { font-size: 1rem; color: var(--color-textcolor); }
    p { color: var(--color-textcolor2); line-height: 1.5; }
    select { padding: .6rem; color: var(--color-textcolor); background: var(--color-darkbg); border: 1px solid var(--settings-border); border-radius: .4rem; max-width: 100%; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
</style>
