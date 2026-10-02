import { describe, expect, test, vi } from 'vitest'
import { parseProviderOutputTokenLimit, requestWithProviderOutputLimit } from './providerOutputTokenLimit'

describe('provider output token limit', () => {
    test.each([
        ['Vertex AI 요청 실패 (Gemini 형식, HTTP 400): { "error": { "code": 400, "message": "Unable to submit request because it has a maxOutputTokens value of 131072 but the supported range is from 1 (inclusive) to 65537 (exclusive). Update the value and try again." } }', 65_536],
        ['max_tokens: 131072 > 64000, which is the maximum allowed number of output tokens for claude-x', 64_000],
        ['max_tokens is too large: 131072. This model supports at most 16384 completion tokens, whereas you provided 131072.', 16_384],
        ['Invalid max_output_tokens: must be <= 32,768', 32_768],
    ])('parses %s', (message, expected) => {
        expect(parseProviderOutputTokenLimit(message, 131_072)).toBe(expected)
    })

    test('ignores unrelated failures and limits that do not lower the request', () => {
        expect(parseProviderOutputTokenLimit('Rate limit: at most 60 requests per minute', 131_072)).toBeUndefined()
        expect(parseProviderOutputTokenLimit('Context too long: at most 1048576 tokens', 131_072)).toBeUndefined()
        expect(parseProviderOutputTokenLimit('max_tokens must be at most 65536', 8_192)).toBeUndefined()
    })

    test('retries once with the provider maximum', async () => {
        const send = vi.fn(async (request: { maxTokens: number }) => request.maxTokens > 65_536
            ? { type: 'fail', result: 'maxOutputTokens supported range is from 1 (inclusive) to 65537 (exclusive)' }
            : { type: 'success', result: 'ok' })
        await expect(requestWithProviderOutputLimit({ maxTokens: 131_072 }, send)).resolves.toEqual({ type: 'success', result: 'ok' })
        expect(send.mock.calls.map(([request]) => request.maxTokens)).toEqual([131_072, 65_536])
    })
})
