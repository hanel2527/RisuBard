<script lang="ts">
    // Thin alias around ShSelect — kept for the existing 22+ call sites that
    // already import SelectInput. New code should import ShSelect directly.
    // See .agent/guide/ui.md "Select 컴포넌트 사용".
    import ShSelect from './ShSelect.svelte';

    interface Props {
        value: string | number;
        className?: string;
        size?: 'sm'|'md'|'lg'|'xl';
        ariaLabel?: string;
        children?: import('svelte').Snippet;
        onchange?: (event: Event & {
            currentTarget: EventTarget & HTMLSelectElement;
        }) => any;
    }

    let {
        value = $bindable(),
        className = "",
        size = 'md',
        ariaLabel,
        children,
        onchange
    }: Props = $props();
</script>

<ShSelect bind:value {className} {size} {onchange} {ariaLabel}>
    {@render children?.()}
</ShSelect>
