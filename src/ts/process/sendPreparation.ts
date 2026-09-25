/** Bound this send's wait without cancelling the shared save/sync operation. */
export async function waitForSendSync(
    refresh: () => Promise<void>,
    options: { signal?: AbortSignal, timeoutMs?: number, timeoutMessage?: string } = {},
): Promise<void> {
    const { signal, timeoutMs = 30_000, timeoutMessage = 'Chat synchronization timed out' } = options
    const abortError = () => new DOMException('Send cancelled', 'AbortError')
    if (signal?.aborted) throw abortError()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const interrupted = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
        onAbort = () => reject(abortError())
        signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
        await Promise.race([Promise.resolve().then(() => {
            if (signal?.aborted) throw abortError()
            return refresh()
        }), interrupted])
        if (signal?.aborted) throw abortError()
    } finally {
        clearTimeout(timer)
        if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
}
