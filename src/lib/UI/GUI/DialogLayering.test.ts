import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('application overlay layering', () => {
    test('uses the original static layer contract without a global draw-order observer', () => {
        const app = source('src/App.svelte')
        const dialog = source('src/lib/UI/GUI/ShDialog.svelte')
        const alert = source('src/lib/UI/GUI/ShAlertDialog.svelte')
        const loading = source('src/lib/UI/GUI/ShLoadingDialog.svelte')
        const dropdown = source('src/lib/UI/GUI/ShDropdownMenuContent.svelte')
        const select = source('src/lib/UI/GUI/ShSelect.svelte')
        const toaster = source('src/lib/UI/GUI/Toaster.svelte')
        const tooltip = source('src/ts/gui/tooltip.ts')
        const personaBuilder = source('src/lib/Others/PersonaBuilder.svelte')
        const pluginApi = source('src/ts/plugins/apiV3/v3.svelte.ts')

        expect(app).not.toContain('observeModalLayers')
        expect(existsSync(resolve(process.cwd(), 'src/lib/UI/GUI/modalLayerStack.ts'))).toBe(false)
        for (const component of [dialog, alert, loading]) {
            expect(component).toContain("base: 'z-40'")
            expect(component).toContain("alert: 'z-50'")
            expect(component).toContain("top: 'z-[60]'")
            expect(component).not.toContain('data-risu-modal-tier')
        }
        expect(alert).toContain("tier = 'alert'")
        expect(dropdown).toContain("'z-50 min-w-32")
        expect(dropdown).not.toContain('data-risu-floating-layer')
        expect(select).toContain('class="fixed z-50')
        expect(select).not.toContain('data-risu-floating-layer')
        expect(toaster).not.toContain('data-sonner-toaster')
        expect(tooltip).not.toContain('layerAbove')
        expect(personaBuilder).toContain('overlayClass="z-[45]"')
        expect(personaBuilder).toContain('contentClass="persona-builder-dialog z-[45]"')
        expect(pluginApi).toContain('iframe.style.zIndex = "1000"')
        expect(pluginApi).not.toContain('iframe.dataset.risuModalTier')
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
