import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('lore builder UI contract', () => {
    it('offers lore presets, four explicit context switches, and iterative draft controls', () => {
        const builder = source('src/lib/Others/LoreBuilder.svelte')

        expect(builder).toContain('LorePromptPresetEditor')
        expect(builder).toContain('data-lore-builder-context')
        expect(builder.match(/type="checkbox"/g)).toHaveLength(4)
        expect(builder).toContain('data-lore-builder-instruction')
        expect(builder).toContain('data-lore-builder-send')
        expect(builder).toContain('data-lore-builder-reset')
        expect(builder).toContain('data-lore-builder-draft')
        expect(builder).toContain('data-lore-builder-undo')
        expect(builder).toContain('data-lore-builder-apply')
        expect(builder).toContain("logPurpose: 'lore-builder'")
    })

    it('uses a scrollable opaque child dialog above the lore workspace', () => {
        const builder = source('src/lib/Others/LoreBuilder.svelte')

        expect(builder).toContain('tier="alert"')
        expect(builder).toContain('bodyClass="min-h-0 overflow-y-auto"')
        expect(builder).toContain('height: 90vh')
        expect(builder).toContain('background: var(--color-surface-base)')
        expect(builder).toContain('closeOnEscape={true}')
        expect(builder).toContain('closeOnOutsideClick={false}')
        expect(builder).toContain('role="alert"')
        expect(builder).toContain('aria-busy={generating}')
    })

    it('preserves the current instruction after generation and guards stale abort cleanup', () => {
        const builder = source('src/lib/Others/LoreBuilder.svelte')

        expect(builder.match(/userInstruction = ''/g)).toHaveLength(1)
        expect(builder).toMatch(/finally\s*\{\s*if \(abortController === controller\) \{\s*abortController = null\s*generating = false/s)
    })
})
