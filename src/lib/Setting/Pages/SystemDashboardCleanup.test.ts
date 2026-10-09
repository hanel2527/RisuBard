import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8')

describe('system dashboard orphan cleanup surface', () => {
    it('offers one confirmed and loading-safe cleanup action for every orphan category', () => {
        const dashboard = read('src/lib/Setting/Pages/SystemDashboard.svelte')
        const korean = read('src/lang/ko.ts')
        const english = read('src/lang/en.ts')

        expect(dashboard).toContain('async function cleanupAllOrphans()')
        expect(dashboard).toContain("fetch('/api/db/orphans/cleanup'")
        expect(dashboard).toContain('language.storageOrphanCleanupConfirm')
        expect(dashboard).toContain('language.storageOrphanCleanupMedia')
        expect(dashboard).toContain('language.storageOrphanCleanupHypa')
        expect(dashboard).toContain('language.storageOrphanCleanupObjects')
        expect(dashboard).toContain('disabled={orphanCleanupOpen || !hasCleanupCandidates}')
        expect(dashboard).toContain('aria-live="polite"')
        expect(dashboard).not.toContain('stats.storage.reclaimable < 50 * 1024 * 1024')

        for (const source of [korean, english]) {
            expect(source).toContain('storageOrphanCleanupAll:')
            expect(source).toContain('storageOrphanCleanupDone:')
        }
    })

    it('offers a separate confirmed deletion for the rebuildable BardWiki vector cache', () => {
        const dashboard = read('src/lib/Setting/Pages/SystemDashboard.svelte')

        expect(dashboard).toContain("fetch('/api/bardwiki-vectors/usage'")
        expect(dashboard).toContain("fetch('/api/bardwiki-vectors/clear'")
        expect(dashboard).toContain('language.storageBardWikiVectorsConfirm')
        expect(dashboard).toContain('disabled={vectorClearOpen || !vectorUsage || vectorUsage.count === 0}')
        // The orphan cleanup must not delete vectors that are still in use.
        expect(dashboard.slice(dashboard.indexOf('async function cleanupAllOrphans()'), dashboard.indexOf('async function loadVectorUsage()')))
            .not.toContain('bardwiki-vectors')
        for (const source of [read('src/lang/ko.ts'), read('src/lang/en.ts')]) {
            expect(source).toContain('storageBardWikiVectorsClear:')
            expect(source).toContain('storageBardWikiVectorsDone:')
        }
    })
})
