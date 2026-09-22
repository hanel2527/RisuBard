<script lang="ts">
    import type { SettingItem } from 'src/ts/setting/types'
    let { items, compact }: { items: SettingItem[]; compact?: boolean } = $props()
</script>
<div data-test-renderer data-compact={compact}>
    {#each items as item (item.id)}
        {#if item.type === 'header'}
            <h2>{item.labelKey}</h2>
        {:else}
            <input data-setting-id={item.id === 'risubard.common.embedding' ? 'risubard.embedding' : item.id} aria-label={item.id} />
        {/if}
    {/each}
</div>
