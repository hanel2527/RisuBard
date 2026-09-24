import { describe, expect, test, vi } from 'vitest'
import {
    rerankWithBardChan,
    shouldRunBardChan,
    type BardChanCandidate,
} from './bardChanReranker'

const candidates: BardChanCandidate[] = [{
    documentId: 'chapel', type: 'event', title: '성당에서의 약속',
    excerpt: '술집에서 했던 말을 기억했다.', score: 8,
}, {
    documentId: 'garden', type: 'event', title: '정원의 재회',
    excerpt: '꽃을 보며 재회했다.', score: 7.6,
}]

describe('Bard-chan reranker', () => {
    test('rejects IDs outside the eight cards actually shown to the model', async () => {
        const many = Array.from({ length: 10 }, (_, index) => ({
            ...candidates[0], documentId: `doc-${index}`, score: 10 - index / 10,
        })).reverse()
        const requestModel = vi.fn(async () => ({ type: 'success' as const,
            result: JSON.stringify({ ids: ['doc-9', 'doc-0', 'doc-1'] }) }))
        const result = await rerankWithBardChan({ enabled: true, modelMode: 'memory',
            currentInput: 'Recall', candidates: many, requestModel })
        expect(result.map(item => item.documentId)).toEqual(['doc-0', 'doc-1'])
    })

    test('bounds recent context and keeps it distinct from the current query', async () => {
        const requestModel = vi.fn(async (_request: { formated: { content: string }[] }) => ({
            type: 'success' as const, result: '{"ids":["chapel"]}',
        }))
        await rerankWithBardChan({ enabled: true, modelMode: 'memory',
            currentInput: '그 약속 말이야.', recentContext: 'older'.repeat(1000) + '성당에서 만났다.',
            candidates, requestModel })
        const payload = JSON.parse(requestModel.mock.calls[0][0].formated[1].content)
        expect(payload.query).toBe('그 약속 말이야.')
        expect(payload.recentContext).toHaveLength(1024)
        expect(payload.recentContext).toMatch(/성당에서 만났다\.$/)
        expect(requestModel).toHaveBeenCalledOnce()
    })

    test('does not call the model just because recent context was supplied', async () => {
        const requestModel = vi.fn(async () => ({ type: 'fail' as const, result: '' }))
        for (const enabled of [false, true]) {
            expect(await rerankWithBardChan({ enabled, modelMode: 'memory',
                currentInput: 'Continue', recentContext: 'The last scene',
                candidates: candidates.slice(0, 1), requestModel })).toEqual([])
        }
        expect(requestModel).not.toHaveBeenCalled()
    })

    test('runs only when enabled candidates are meaningfully ambiguous', () => {
        expect(shouldRunBardChan(false, candidates)).toBe(false)
        expect(shouldRunBardChan(true, candidates.slice(0, 1))).toBe(false)
        expect(shouldRunBardChan(true, candidates)).toBe(true)
        expect(shouldRunBardChan(true, [
            candidates[0], { ...candidates[1], score: 1 },
        ])).toBe(false)
    })

    test('sends compact cards once and accepts only returned candidate IDs', async () => {
        const requestModel = vi.fn(async (
            _request: { formated: unknown[] },
            _model: 'memory',
        ) => ({
            type: 'success' as const,
            result: JSON.stringify({ ids: ['garden', 'unknown', 'chapel'] }),
        }))

        const result = await rerankWithBardChan({
            enabled: true,
            modelMode: 'memory',
            currentInput: '그때 했던 말이 뭐였지?',
            candidates,
            realChatId: 'chat-1',
            requestModel,
        })

        expect(result).toEqual([
            { documentId: 'garden', score: 1 },
            { documentId: 'chapel', score: 0.5 },
        ])
        expect(requestModel).toHaveBeenCalledOnce()
        expect(requestModel).toHaveBeenCalledWith(expect.objectContaining({
            useStreaming: false,
            noMultiGen: true,
            maxTokens: 64,
            temperature: 0,
            tools: [],
            blockPlugins: true,
            realChatId: 'chat-1',
            logSource: 'memory',
            logPurpose: 'bardwiki-bard-chan-rerank',
        }), 'memory')
        const request = requestModel.mock.calls[0]?.[0]
        expect(request).toBeDefined()
        if (!request) throw new Error('Bard-chan request was not captured')
        expect(JSON.stringify(request.formated).length).toBeLessThan(6_000)
    })

    test('keeps deterministic results when the auxiliary model fails', async () => {
        const requestModel = vi.fn(async () => ({
            type: 'fail' as const,
            result: 'sub model is unset',
            bindingFailure: 'sub-unset' as const,
        }))

        await expect(rerankWithBardChan({
            enabled: true,
            modelMode: 'memory',
            currentInput: '그때 했던 말',
            candidates,
            requestModel,
        })).resolves.toEqual([])
        expect(requestModel).toHaveBeenCalledOnce()
    })

    test('uses the independently selected main model', async () => {
        const requestModel = vi.fn(async () => ({
            type: 'success' as const,
            result: JSON.stringify({ ids: ['chapel', 'garden'] }),
        }))

        await rerankWithBardChan({
            enabled: true,
            modelMode: 'model',
            currentInput: '약속이 뭐였지?',
            candidates,
            requestModel,
        })

        expect(requestModel).toHaveBeenCalledWith(
            expect.any(Object),
            'model',
        )
    })
})
