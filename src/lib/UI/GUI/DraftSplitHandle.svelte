<script lang="ts">
    import { resizeHandle } from 'src/ts/gui/resizeHandle'

    let { target, ariaLabel }: { target: HTMLElement | null; ariaLabel: string } = $props()
    let handleElement: HTMLButtonElement

    function startResize() {
        const element = target
        if (!element) return
        const availableWidth = Math.max(0, element.getBoundingClientRect().width - (handleElement.getBoundingClientRect().width || 16))
        const originalPane = element.querySelector<HTMLElement>('[data-draft-pane="original"]')
        const initialLeftWidth = originalPane?.getBoundingClientRect().width || availableWidth / 2
        const minimumPaneWidth = Math.min(200, availableWidth / 2)
        return (dx: number) => {
            const leftWidth = Math.min(availableWidth - minimumPaneWidth, Math.max(minimumPaneWidth, initialLeftWidth + dx))
            element.style.setProperty('--draft-left-width', `${leftWidth}px`)
            element.style.setProperty('--draft-right-width', `${availableWidth - leftWidth}px`)
        }
    }

    function resetSplit() {
        target?.style.removeProperty('--draft-left-width')
        target?.style.removeProperty('--draft-right-width')
    }
</script>

<button
    bind:this={handleElement}
    type="button"
    data-draft-split-resize
    class="draft-split-resize"
    aria-label={ariaLabel}
    title={ariaLabel}
    use:resizeHandle={{ start: startResize, reset: resetSplit }}
></button>

<style>
    .draft-split-resize {
        position: relative;
        width: 1rem;
        min-height: 2.75rem;
        padding: 0;
        border: 0;
        background: transparent;
        cursor: col-resize;
        touch-action: none;
    }
    .draft-split-resize::after {
        position: absolute;
        top: 1rem;
        bottom: 1rem;
        left: calc(50% - 1px);
        width: 2px;
        border-radius: 999px;
        background: var(--color-darkborderc);
        content: '';
        transition: background-color 160ms ease, width 160ms ease;
    }
    .draft-split-resize:hover::after,
    .draft-split-resize:focus-visible::after,
    .draft-split-resize:global([data-resizing])::after {
        width: 3px;
        background: var(--color-borderc);
    }
    .draft-split-resize:focus-visible {
        border-radius: .35rem;
        outline: 2px solid var(--color-borderc);
        outline-offset: -2px;
    }
    @media (max-width: 700px) {
        .draft-split-resize { display: none; }
    }
</style>
