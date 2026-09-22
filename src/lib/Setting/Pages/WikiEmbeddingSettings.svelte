<script lang="ts">
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import { DBState } from 'src/ts/stores.svelte'
    import { SettingsRoute } from 'src/ts/routing'
    import { navigateToSearchResult } from 'src/ts/setting/searchIndex'

    let settings = $derived(DBState.db.risuBardEmbeddingSettings)
    function openModelSettings() {
        navigateToSearchResult({
            key: 'hypa.embedding', label: '임베딩 모델', location: 'Hypa', rank: 0,
            route: SettingsRoute.OtherBots, subTab: 0, itemId: 'hypa.embedding',
        })
    }
</script>

<div data-setting-row data-setting-id="risubard.embedding" class="settings-standard-row flex items-center justify-between gap-4 border-t border-darkborderc">
    <span class="text-sm text-textcolor">바드위키 의미 검색 임베딩 활성</span>
    <div class="flex shrink-0 items-center gap-3">
        <button type="button" class="rounded-md border border-darkborderc px-3 py-1.5 text-xs text-textcolor hover:bg-darkbutton" onclick={openModelSettings}>모델 설정</button>
        <CheckInput bind:check={settings.enabled} name="바드위키 의미 검색 임베딩 활성" hiddenName margin={false} />
    </div>
</div>
