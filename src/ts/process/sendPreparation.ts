/** Wait for synchronization without a time limit; only the user's cancel stops it. */
export async function waitForSendSync(
    refresh: () => Promise<void>,
    options: { signal?: AbortSignal } = {},
): Promise<void> {
    const { signal } = options
    const abortError = () => new DOMException('Send cancelled', 'AbortError')
    if (signal?.aborted) throw abortError()
    let onAbort: (() => void) | undefined
    const interrupted = new Promise<never>((_, reject) => {
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
        if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
}
