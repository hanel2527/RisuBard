import { describe, expect, it, vi } from 'vitest'
import { createSessionHandoff } from './sessionHandoff'

function setup() {
    const hooks = {
        isActive: () => true,
        isVisible: () => true,
        choose: vi.fn(async (): Promise<'download' | 'reload' | 'cancel'> => 'cancel'),
        download: vi.fn(async () => {}),
        confirmReload: vi.fn(async () => true),
        canReload: vi.fn(async () => true),
        reload: vi.fn(),
        notifyPaused: vi.fn(),
        notifyBusy: vi.fn(),
        onError: vi.fn(),
    }
    return { hooks, handoff: createSessionHandoff(hooks) }
}

describe('session handoff preserves unsaved work', () => {
    it('pauses synchronously and never reloads on detection or cancellation', async () => {
        const { hooks, handoff } = setup()
        const pending = handoff.deactivate()
        expect(handoff.isPaused()).toBe(true)
        await pending
        expect(hooks.notifyPaused).toHaveBeenCalledOnce()
        expect(hooks.reload).not.toHaveBeenCalled()
        expect(handoff.shouldBlockUnload()).toBe(true)
        await handoff.deactivate()
        expect(hooks.choose).toHaveBeenCalledOnce()
    })

    it('downloads the current recovery snapshot without reloading or resuming saves', async () => {
        const { hooks, handoff } = setup()
        hooks.choose.mockResolvedValue('download')
        await handoff.deactivate()
        expect(hooks.download).toHaveBeenCalledOnce()
        expect(hooks.reload).not.toHaveBeenCalled()
        expect(handoff.isPaused()).toBe(true)
        expect(handoff.shouldBlockUnload()).toBe(true)
    })

    it('requires a second confirmation to discard local edits', async () => {
        const { hooks, handoff } = setup()
        hooks.choose.mockResolvedValue('reload')
        hooks.confirmReload.mockResolvedValue(false)
        await handoff.deactivate()
        expect(hooks.reload).not.toHaveBeenCalled()
        expect(handoff.shouldBlockUnload()).toBe(true)
        hooks.confirmReload.mockResolvedValue(true)
        await handoff.show()
        expect(hooks.reload).toHaveBeenCalledOnce()
        expect(handoff.shouldBlockUnload()).toBe(false)
    })

    it('does not reload while a generation or save is still running', async () => {
        const { hooks, handoff } = setup()
        hooks.choose.mockResolvedValue('reload')
        hooks.canReload.mockResolvedValue(false)
        await handoff.deactivate()
        expect(hooks.reload).not.toHaveBeenCalled()
        expect(hooks.notifyBusy).toHaveBeenCalledOnce()
        expect(handoff.shouldBlockUnload()).toBe(true)
    })

    it('defers hidden-tab dialogs and coalesces simultaneous notifications', async () => {
        const { hooks, handoff } = setup()
        hooks.isVisible = () => false
        await handoff.deactivate()
        expect(hooks.choose).not.toHaveBeenCalled()
        hooks.isVisible = () => true
        await Promise.all([handoff.show(), handoff.show(), handoff.deactivate()])
        expect(hooks.choose).toHaveBeenCalledOnce()
    })

    it('keeps protection after a failed recovery download', async () => {
        const { hooks, handoff } = setup()
        hooks.choose.mockResolvedValue('download')
        hooks.download.mockRejectedValue(new Error('download failed'))
        await handoff.deactivate()
        expect(hooks.onError).toHaveBeenCalledOnce()
        expect(hooks.reload).not.toHaveBeenCalled()
        expect(handoff.shouldBlockUnload()).toBe(true)
    })

    it('rechecks runtime ownership after confirmation', async () => {
        const { hooks, handoff } = setup()
        hooks.choose.mockResolvedValue('reload')
        hooks.confirmReload.mockImplementation(async () => {
            hooks.isActive = () => false
            return true
        })
        await handoff.deactivate()
        expect(hooks.reload).not.toHaveBeenCalled()
    })
})
