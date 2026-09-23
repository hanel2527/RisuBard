<script lang="ts">
    import type { Snippet } from 'svelte';
    import { getContext } from 'svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import type { SettingItem } from 'src/ts/setting/types';
    import { getLabel } from 'src/ts/setting/utils';
    import { language } from 'src/lang';

    interface Props {
        item: SettingItem;
        /** The control, rendered right-aligned and vertically centered. */
        control?: Snippet;
    }

    let { item, control }: Props = $props();
    const compact = getContext<() => boolean>('settings-compact-rows') ?? (() => false);

    // Inline help text under the label (replaces the tooltip icon in row mode).
    const helpText = $derived(
        item.helpKey ? (language.help as any)[item.helpKey] : undefined
    );
</script>

<!-- data-setting-id: anchor for settings search deep-links (searchIndex.ts) -->
<div
    data-setting-row
    data-setting-id={item.id}
    class="settings-standard-row flex items-center justify-between gap-4 border-t border-darkborderc"
>
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-textcolor">{getLabel(item)}{#if compact() && item.helpKey}<Help key={item.helpKey as any} name={getLabel(item)} unrecommended={item.helpUnrecommended ?? false} />{/if}</span>
        {#if helpText && !compact()}<p class="text-xs text-textcolor2 mt-0.5 whitespace-pre-line">{helpText}</p>{/if}
    </div>
    <div class="shrink-0">{@render control?.()}</div>
</div>
