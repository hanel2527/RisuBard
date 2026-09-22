<script lang="ts">
    import { setContext } from 'svelte';
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import type { LLMModel } from 'src/ts/model/types';
    import { DBState } from 'src/ts/stores.svelte';
    import { getModelInfo } from 'src/ts/model/modellist';
    import { settingRegistry } from 'src/ts/setting/settingRegistry';
    import { checkCondition } from 'src/ts/setting/utils';

    interface Props {
        items: SettingItem[];
        /** Optional modelInfo, derived automatically if not provided */
        modelInfo?: LLMModel;
        /** Optional subModelInfo, derived automatically if not provided */
        subModelInfo?: LLMModel;
        /** 'row' renders row-capable wrappers (select/text/slider) with the label
         * + inline help on the left and the control right-aligned. 'block' renders
         * the ModelPreset-editor field grammar (label row + full-width control).
         * Default 'row' so every option page inherits the shared visual grammar. */
        layout?: 'stacked' | 'row' | 'block';
        compact?: boolean;
    }

    let { items, modelInfo, subModelInfo, layout = 'row', compact = false }: Props = $props();
    setContext('settings-compact-rows', () => compact);

    // Derive modelInfo if not provided
    let effectiveModelInfo = $derived(modelInfo ?? getModelInfo(DBState.db.aiModel));
    let effectiveSubModelInfo = $derived(subModelInfo ?? getModelInfo(DBState.db.subModel));

    // Build context for condition checks
    let ctx: SettingContext = $derived({
        db: DBState.db,
        modelInfo: effectiveModelInfo,
        subModelInfo: effectiveSubModelInfo,
        layout,
    });

    interface SettingItemGroup {
        header?: SettingItem;
        items: SettingItem[];
    }

    function groupByHeader(source: SettingItem[]): SettingItemGroup[] {
        const groups: SettingItemGroup[] = [];
        let current: SettingItemGroup = { items: [] };

        for (const item of source) {
            if (item.type === 'header') {
                if (current.header || current.items.length > 0) groups.push(current);
                current = { header: item, items: [] };
            } else {
                current.items.push(item);
            }
        }

        if (current.header || current.items.length > 0) groups.push(current);
        return groups;
    }

    let visibleItems = $derived(items.filter((item) => checkCondition(item, ctx)));
    let groupedItems = $derived(groupByHeader(visibleItems));
</script>

{#snippet settingItem(item: SettingItem)}
    {@const Component = settingRegistry[item.type]}
    {#if Component}
        <Component {item} {ctx} />
    {:else}
        <div class="text-draculared text-xs mt-2">Unknown setting type: {item.type}</div>
    {/if}
{/snippet}

{#if layout === 'row' || layout === 'block'}
    {#each groupedItems as group, index (`${group.header?.id ?? 'root'}-${index}`)}
        {#if group.header}
            <div class="settings-standard-section-heading">
                {@render settingItem(group.header)}
            </div>
        {/if}
        {#if group.items.length > 0}
            <div data-settings-group class="settings-standard-group [&>*:first-child]:border-t-0">
                {#each group.items as item (item.id)}
                    {@render settingItem(item)}
                {/each}
            </div>
        {/if}
    {/each}
{:else}
    <div class="settings-standard-stack">
        {#each visibleItems as item (item.id)}
            {@render settingItem(item)}
        {/each}
    </div>
{/if}
