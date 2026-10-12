<script lang="ts">
    import type { Snippet } from 'svelte'
    import { tooltip } from 'src/ts/gui/tooltip'

    let { label, onclick, disabled = false, pressed, expanded, tone = 'ghost', children }: {
        label: string
        onclick?: (event: MouseEvent) => void
        disabled?: boolean
        pressed?: boolean
        expanded?: boolean
        tone?: 'ghost' | 'danger'
        children: Snippet
    } = $props()
</script>

<button type="button" class="icon-button" class:danger={tone === 'danger'} aria-label={label} aria-pressed={pressed} aria-expanded={expanded} {disabled} {onclick} use:tooltip={label}>{@render children()}</button>

<style>
    .icon-button { display: inline-grid; place-items: center; flex-shrink: 0; width: 2rem; height: 2rem; padding: 0; border: 0; border-radius: .4rem; background: transparent; color: var(--color-textcolor2); transition: background-color .15s ease-out, color .15s ease-out; }
    .icon-button:hover:not(:disabled), .icon-button[aria-pressed='true'], .icon-button[aria-expanded='true'] { background: var(--color-darkbutton); color: var(--color-textcolor); }
    .icon-button[aria-pressed='true'] { color: var(--color-primary); }
    .icon-button.danger:hover:not(:disabled) { color: var(--color-danger); }
    .icon-button:disabled { opacity: .4; cursor: not-allowed; }
    .icon-button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
    @media (pointer: coarse) { .icon-button { width: 2.75rem; height: 2.75rem; } }
</style>
