<script lang="ts">
    import { Toaster as SonnerToaster, type ToasterProps } from 'svelte-sonner';
    import { isTouchDevice } from 'src/ts/stores.svelte';

    let { ...rest }: ToasterProps = $props();

    const position = $derived<ToasterProps['position']>($isTouchDevice ? 'top-center' : 'top-right');
</script>

<SonnerToaster
    theme="dark"
    {position}
    richColors
    duration={3500}
    visibleToasts={8}
    toastOptions={{
        classes: {
            toast: 'risu-toast',
            title: 'risu-toast-title',
            description: 'risu-toast-description',
        },
    }}
    style="
        --normal-bg: var(--risu-theme-darkbg);
        --normal-text: var(--risu-theme-textcolor);
        --normal-border: var(--risu-theme-darkborderc);
        font-family: inherit;
    "
    {...rest}
/>

<style>
    :global([data-sonner-toaster]) {
        /* Alert dialogs use 2147483600 and top-tier blockers use 2147483640.
           Keep live request evidence readable above ordinary dialogs without
           piercing confirmations and loading blockers. */
        z-index: 2147483620 !important;
    }
    :global(.risu-toast) {
        border-radius: 0.375rem;
        font-size: 0.875rem;
    }
    :global(.risu-toast-title) {
        font-weight: 500;
    }
</style>
