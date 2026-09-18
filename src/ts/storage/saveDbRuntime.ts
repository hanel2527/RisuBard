const SAVE_DB_RUNTIME = Symbol.for('risubard.save-db-runtime')

export interface SaveDbRuntime {
    isActive(): boolean
    addCleanup(cleanup: () => void): void
    stop(): Promise<void>
}

export async function claimSaveDbRuntime(
    scope: object,
    waitForIdle: () => Promise<void>
): Promise<SaveDbRuntime> {
    let stopped = false
    const cleanups = new Set<() => void>()
    const runtime: SaveDbRuntime = {
        isActive: () => !stopped && Reflect.get(scope, SAVE_DB_RUNTIME) === runtime,
        addCleanup(cleanup) {
            if (stopped) cleanup()
            else cleanups.add(cleanup)
        },
        async stop() {
            if (stopped) return
            stopped = true
            for (const cleanup of cleanups) {
                try { cleanup() } catch {}
            }
            cleanups.clear()
            try { await waitForIdle() } catch {}
        },
    }
    const previous = Reflect.get(scope, SAVE_DB_RUNTIME) as SaveDbRuntime | undefined
    Reflect.set(scope, SAVE_DB_RUNTIME, runtime)
    await previous?.stop()
    if (!runtime.isActive()) await runtime.stop()
    return runtime
}
