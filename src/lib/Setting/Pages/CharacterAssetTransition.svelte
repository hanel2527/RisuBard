<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte'
    import { isNodeServer } from 'src/ts/platform'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'

    let characterId = $state('')
    let busy = $state(false)
    let message = $state('')
    let result = $state<{ enabled: boolean; copied: number; skipped: number; failed: number; diagnostics: { reads: number; fallbacks: number } } | null>(null)
    const characters = $derived(DBState.db.characters)

    async function run(action: 'status' | 'migrate' | 'disable') {
        const id = characterId
        if (!id || busy) return
        busy = true
        result = null
        message = ''
        try {
            await forageStorage.Init()
            result = await forageStorage.realStorage.characterAssetTransition(id, action)
        } catch {
            message = '전환 상태를 확인하지 못했습니다. 저장이 끝난 뒤 다시 시도해 주세요. 기존 KV 원본은 유지됩니다.'
        } finally { busy = false }
    }
</script>

{#if isNodeServer}
    <section class="asset-pilot">
        <h2>캐릭터 에셋 V3 전환 (시험 기능)</h2>
        <p>선택한 캐릭터의 전용 이미지와 추가 에셋만 복사하고 검증합니다. 공유 에셋과 기존 KV 원본은 유지됩니다. 채팅과 전체 저장 형식은 바뀌지 않습니다.</p>
        <label for="asset-transition-character">전환할 캐릭터</label>
        <select id="asset-transition-character" bind:value={characterId} disabled={busy} onchange={() => { result = null; message = '' }}>
            <option value="">캐릭터를 선택해 주세요</option>
            {#each characters as character (character.chaId)}
                <option value={character.chaId}>{character.name}</option>
            {/each}
        </select>
        <div class="actions">
            <ShButton variant="outline" onclick={() => run('status')} disabled={!characterId || busy}>상태 확인</ShButton>
            <ShButton variant="primary" onclick={() => run('migrate')} disabled={!characterId || busy}>{busy ? '처리 중…' : 'V3 구조로 전환 / 재검증'}</ShButton>
            <ShButton variant="outline" onclick={() => run('disable')} disabled={!characterId || busy}>기존 KV 읽기로 되돌리기</ShButton>
        </div>
        <div role="status" aria-live="polite">
            {#if result}
                <p>{result.enabled ? (result.failed ? '일부 실패: 재시도할 수 있습니다.' : result.copied ? '검증된 에셋의 V3 읽기가 활성화되어 있습니다.' : '전환할 전용 에셋이 없습니다.') : '기존 KV 읽기를 사용합니다.'}</p>
                <p>복사 검증 {result.copied}개 / 공유 제외 {result.skipped}개 / 실패 {result.failed}개</p>
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
