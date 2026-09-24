type HandoffChoice = 'download' | 'reload' | 'cancel'

interface HandoffHooks {
    isActive(): boolean
    isVisible(): boolean
    choose(): Promise<HandoffChoice>
    download(): Promise<void>
    confirmReload(): Promise<boolean>
    canReload(): Promise<boolean>
    reload(): void
    notifyPaused(): void
    notifyBusy(): void
    onError(error: unknown): void
}

/** A lost writer never discards local state without an explicit decision. */
export function createSessionHandoff(hooks: HandoffHooks) {
    let paused = false
    let showing = false
    let leaving = false

    async function show() {
        if (!paused || showing || leaving || !hooks.isActive() || !hooks.isVisible()) return
        showing = true
        try {
            const choice = await hooks.choose()
            if (!hooks.isActive()) return
            if (choice === 'download') {
                await hooks.download()
            } else if (choice === 'reload' && await hooks.confirmReload()) {
                if (!hooks.isActive()) return
                if (!await hooks.canReload()) {
                    hooks.notifyBusy()
                    return
                }
                if (!hooks.isActive()) return
                leaving = true
                hooks.reload()
            }
        } catch (error) {
            leaving = false
            hooks.onError(error)
        } finally {
            showing = false
        }
    }

    return {
        isPaused: () => paused,
        shouldBlockUnload: () => paused && !leaving,
        show,
        async deactivate() {
            if (paused || !hooks.isActive()) return
            paused = true
            hooks.notifyPaused()
            await show()
        },
    }
}
