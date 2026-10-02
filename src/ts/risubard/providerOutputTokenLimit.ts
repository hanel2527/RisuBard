const OUTPUT_TOKEN_FIELD = /max(?:imum)?[_ ]?(?:output|completion|new)?[_ ]?tokens|maxOutputTokens|output tokens?|completion tokens?/i

/**
 * Reads the provider's allowed output-token maximum from a rejection message.
 * Provider plugins forward the requested value unchanged and RisuBard cannot
 * see their model metadata, so the rejection is the only reliable signal.
 */
export function parseProviderOutputTokenLimit(message: string, requested: number): number | undefined {
    if (!OUTPUT_TOKEN_FIELD.test(message)) return undefined
    const number = (value: string) => Number(value.replace(/,/g, ''))
    const candidates: number[] = []
    // Vertex/Gemini: "supported range is from 1 (inclusive) to 65537 (exclusive)"
    for (const match of message.matchAll(/to\s+([\d,]+)\s*\(exclusive\)/gi)) candidates.push(number(match[1]) - 1)
    for (const match of message.matchAll(/to\s+([\d,]+)\s*\(inclusive\)/gi)) candidates.push(number(match[1]))
    // Anthropic: "max_tokens: 131072 > 64000, which is the maximum allowed"
    for (const match of message.matchAll(/>\s*([\d,]+)\s*,?\s*which is the maximum/gi)) candidates.push(number(match[1]))
    // OpenAI-compatible: "supports at most 16384 completion tokens", "must be <= 8192"
    for (const match of message.matchAll(/(?:at most|up to|no more than|less than or equal to|<=|maximum(?: value)?(?: is| of)?:?)\s*([\d,]+)/gi)) {
        candidates.push(number(match[1]))
    }
    const valid = candidates.filter((value) => Number.isSafeInteger(value) && value >= 256 && value < requested)
    return valid.length ? Math.max(...valid) : undefined
}

/** Retries once with the provider's maximum when it rejects the output budget. */
export async function requestWithProviderOutputLimit<
    Request extends { maxTokens?: number },
    Response extends { type: string; result?: unknown },
>(request: Request, send: (request: Request) => Promise<Response>): Promise<Response> {
    const response = await send(request)
    if (response.type !== 'fail' || typeof response.result !== 'string'
        || request.maxTokens === undefined) return response
    const limit = parseProviderOutputTokenLimit(response.result, request.maxTokens)
    return limit === undefined ? response : send({ ...request, maxTokens: limit })
}
