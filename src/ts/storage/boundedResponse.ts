/** Only for finite control/save responses, never streaming or asset downloads.
 * A timeout is an unknown write outcome, not proof that the server rolled back.
 * This helper never retries a request.
 */
export async function boundedResponse(
    request: (signal: AbortSignal) => Promise<Response>,
    timeoutMs: number,
    error: Error,
): Promise<Response> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(error)
            controller.abort(error)
        }, timeoutMs)
    })
    try {
        return await Promise.race([
            request(controller.signal).then(async response => {
                const body = await response.arrayBuffer()
                controller.signal.throwIfAborted()
                return new Response([204, 205, 304].includes(response.status) ? null : body, {
                    status: response.status, statusText: response.statusText, headers: response.headers,
                })
            }),
            expired,
        ])
    } finally {
        clearTimeout(timer)
    }
}
