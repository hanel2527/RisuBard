import { describe, expect, test, vi } from 'vitest'
import { claimSaveDbRuntime } from './saveDbRuntime'

describe('saveDb runtime lifecycle', () => {
    test('stops the previous runtime and waits for its active save before takeover', async () => {
        const scope = {}
        let finishSave!: () => void
        const activeSave = new Promise<void>((resolve) => {
            finishSave = resolve
        })
        const cleanup = vi.fn()
        const first = await claimSaveDbRuntime(scope, () => activeSave)
        first.addCleanup(cleanup)

        let takeoverFinished = false
        const takeover = claimSaveDbRuntime(scope, () => Promise.resolve())
            .then((runtime) => {
                takeoverFinished = true
                return runtime
            })
        await Promise.resolve()

        expect(first.isActive()).toBe(false)
        expect(cleanup).toHaveBeenCalledOnce()
        expect(takeoverFinished).toBe(false)

        finishSave()
        const second = await takeover

        expect(second.isActive()).toBe(true)
    })
})
