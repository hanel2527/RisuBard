<script lang="ts">
    import { onMount } from 'svelte'
    import { DBState } from 'src/ts/stores.svelte'
    import { isNodeServer } from 'src/ts/platform'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { modulePackageLabel, refreshPackageStatus } from 'src/ts/storage/packageStatus.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'

    type Action = 'status' | 'migrate' | 'disable' | 'retire-kv' | 'restore-kv'
    type Result = {
        enabled: boolean; directory: string; copied: number; failed: number
        kv?: { retired: number; bytes: number }
        v4?: { retired?: number; shared?: number; unverified?: number; restored?: number; failed?: number }
    }

    let moduleId = $state('')
    let busy = $state(false)
    let message = $state('')
    let result = $state<Result | null>(null)
    const modules = $derived((DBState.db.modules ?? []).filter(module => typeof module?.id === 'string' && module.id))
    const assetCount = (id: string) => modules.find(module => module.id === id)?.assets?.length ?? 0
    const nameCounts = $derived.by(() => {
        const counts = new Map<string, number>()
        for (const module of modules) counts.set(module.name, (counts.get(module.name) ?? 0) + 1)
        return counts
    })
    const megabytes = (bytes: number) => (bytes / 1048576).toFixed(1)
    onMount(() => { void refreshPackageStatus() })

    async function run(action: Action) {
        const id = moduleId
        if (!id || busy) return
        if (!(DBState.db.modules ?? []).some(module => module?.id === id)) {
            moduleId = ''
            result = null
            message = '선택한 모듈이 삭제되었습니다. 다른 모듈을 선택해 주세요.'
            return
        }
        busy = true
        const checking = action === 'migrate' && result?.enabled === true
        result = null
        message = action !== 'migrate' ? ''
            : checking ? `폴더의 에셋 ${assetCount(id)}개를 원본과 대조하는 중입니다. 빠졌거나 바뀐 것만 다시 복사합니다.`
            : `에셋 ${assetCount(id)}개를 폴더로 복사하고 검증하는 중입니다. 에셋이 많으면 몇 분 걸릴 수 있으며, 그동안에도 앱은 평소처럼 쓸 수 있습니다.`
        try {
            await forageStorage.Init()
            result = await forageStorage.realStorage.moduleAssetTransition(id, action)
            message = ''
        } catch {
            const failure = action === 'migrate' ? (checking ? '폴더 점검을 완료하지 못했습니다.' : '에셋 폴더 만들기를 완료하지 못했습니다.')
                : action === 'disable' ? '폴더 읽기 끄기를 완료하지 못했습니다.'
                : action === 'retire-kv' ? 'V4 전환을 완료하지 못했습니다.'
                : action === 'restore-kv' ? 'V4 되돌리기를 완료하지 못했습니다.'
                : '모듈 상태를 확인하지 못했습니다.'
            message = `${failure} 저장이 끝난 뒤 다시 시도해 주세요. KV 원본은 유지됩니다.`
            if (action !== 'status') {
                try {
                    result = await forageStorage.realStorage.moduleAssetTransition(id, 'status')
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
        <h2>모듈 에셋 폴더 (시험 기능)</h2>
        <p>선택한 모듈의 에셋을 <code>modules/모듈이름/assets/</code> 폴더에 복사하고, 원본과 같다고 확인된 복사본에서 읽습니다. 모듈 파일 자체와 KV 원본은 그대로이며, 복사본이 없거나 다르면 KV에서 읽습니다.</p>
        <p>폴더를 만든 뒤 모듈에 넣거나 뺀 에셋은 저장할 때 자동으로 폴더에 반영됩니다. 폴더 파일을 직접 지우거나 고쳤다면 폴더 점검을 눌러 주세요. 빠졌거나 바뀐 에셋만 원본에서 다시 복사합니다.</p>
        <p>폴더는 에셋 수만큼 디스크를 쓰지만 백업에는 들어가지 않습니다. 에셋 자체는 백업에 모두 들어 있으며, 백업을 복원하면 폴더를 다시 만들어야 합니다. 삭제한 모듈의 폴더는 휴지통으로 옮겨집니다.</p>
        <label for="module-asset-module">모듈</label>
        <select id="module-asset-module" bind:value={moduleId} disabled={busy} onchange={() => { result = null; message = '' }}>
            <option value="">모듈을 선택해 주세요</option>
            {#each modules as module (module.id)}
                <option value={module.id}>{module.name}{(nameCounts.get(module.name) ?? 0) > 1 ? ` (${module.id})` : ''} / 에셋 {module.assets?.length ?? 0}개{modulePackageLabel(module.id) ? ` [${modulePackageLabel(module.id)}]` : ''}</option>
            {/each}
        </select>
        <div class="actions">
            <ShButton variant="outline" onclick={() => run('status')} disabled={!moduleId || busy}>상태 확인</ShButton>
            <ShButton variant={result?.enabled ? 'outline' : 'primary'} onclick={() => run('migrate')} disabled={!moduleId || busy}>{busy ? '처리 중…' : result?.enabled ? '폴더 점검' : '에셋 폴더 만들기'}</ShButton>
            <ShButton variant="outline" onclick={() => run('disable')} disabled={!moduleId || busy || !result?.enabled}>폴더 읽기 끄기</ShButton>
        </div>
        <div class="actions">
            <ShButton variant="primary" onclick={() => run('retire-kv')} disabled={!moduleId || busy || !result?.enabled}>V4로 전환</ShButton>
            <ShButton variant="outline" onclick={() => run('restore-kv')} disabled={!moduleId || busy || !result?.kv?.retired}>V4 되돌리기</ShButton>
        </div>
        <div role="status" aria-live="polite">
            {#if !result && !message}
                <p>모듈을 고르고 상태 확인을 누르면 사용할 수 있는 동작이 켜집니다.</p>
            {/if}
            {#if result}
                <p>{result.enabled ? `폴더 사용 중: modules/${result.directory}/assets` : '폴더 미사용: 에셋을 KV에서 읽습니다.'}</p>
                {#if result.enabled || result.copied || result.failed}
                    <p>복사 검증 {result.copied}개 / 실패 {result.failed}개</p>
                {/if}
                <p>{result.kv?.retired ? `V4 사용 중: KV 목록에서 뺀 에셋 ${result.kv.retired}개 (${megabytes(result.kv.bytes)}MB)` : 'V4 미사용: 에셋이 모두 KV 목록에 있습니다.'}</p>
                {#if result.v4?.retired !== undefined}
                    <p>이번 전환: {result.v4.retired}개 이동 / 공유 에셋이라 유지 {result.v4.shared ?? 0}개 / 복사본 검증 실패로 유지 {result.v4.unverified ?? 0}개</p>
                {/if}
                {#if result.v4?.restored !== undefined}
                    <p>되돌리기: {result.v4.restored}개를 KV 목록에 복원{result.v4.failed ? ` / 복원 실패 ${result.v4.failed}개 (보관 목록에 그대로 둠)` : ''}</p>
                {/if}
            {/if}
            {#if message}<p>{message}</p>{/if}
        </div>
    </section>
{/if}

<style>
    .asset-pilot { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; gap: .7rem; padding: 1rem; background: var(--settings-surface); border: 1px solid var(--settings-border); border-radius: var(--settings-radius); }
    h2 { font-size: 1rem; color: var(--color-textcolor); }
    p { color: var(--color-textcolor2); line-height: 1.5; overflow-wrap: anywhere; }
    code { font-size: .85em; }
    select { padding: .6rem; color: var(--color-textcolor); background: var(--color-darkbg); border: 1px solid var(--settings-border); border-radius: .4rem; max-width: 100%; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
</style>
