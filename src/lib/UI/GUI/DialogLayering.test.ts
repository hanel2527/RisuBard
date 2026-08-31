import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('application overlay layering', () => {
    test('keeps BardWiki below the relative modal stack and notifications', () => {
        const app = source('src/App.svelte')
        const wiki = source('src/lib/Others/RisuBardMemoryWiki.svelte')
        const toaster = source('src/lib/UI/GUI/Toaster.svelte')
        const stack = source('src/lib/UI/GUI/modalLayerStack.ts')

        expect(wiki).toMatch(/\.memory-wiki-dock\s*\{[\s\S]*?z-index:\s*51/)
        expect(stack).toContain('const MODAL_LAYER_BASE = 1_000_000')
        expect(stack).toContain("const MODAL_SELECTOR = '.risu-modal-overlay, .risu-modal-surface'")
        expect(app).toContain('onMount(() => observeModalLayers(document.body))')
        expect(toaster).toContain('z-index: 2147483620 !important')
    })

    test('places the reboot choice dialog in the top confirmation tier', () => {
        const wiki = source('src/lib/Others/RisuBardMemoryWiki.svelte')
        const chooser = wiki.slice(
            wiki.indexOf('{#if rebootChooserOpen}'),
            wiki.indexOf('{#snippet rebootChooserFooter')
        )
        expect(chooser).toContain('tier="top"')
    })
})
