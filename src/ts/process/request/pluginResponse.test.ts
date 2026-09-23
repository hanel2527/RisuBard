import { describe, expect, it } from 'vitest'
import { preparePluginResponse } from './pluginResponse'

describe('plugin response metadata', () => {
    it('preserves provider token exhaustion and usage after stream collection', () => {
        const response = { success: true, content: 'stream placeholder', finishReason: 'MAX_TOKENS', usage: { completionTokens: 8000 } }
        expect(preparePluginResponse(response, '{"entries":[', 'pluginmodel:::test')).toEqual({
            type: 'success', result: '{"entries":[', model: 'pluginmodel:::test',
            finishReason: 'MAX_TOKENS', usage: { completionTokens: 8000 },
        })
    })

    it('leaves omitted metadata unknown for legacy plugins', () => {
        expect(preparePluginResponse({ success: true }, 'answer', 'legacy')).toEqual({
            type: 'success', result: 'answer', model: 'legacy',
        })
    })

    it('preserves failed provider metadata without interpreting generated text as transport errors', () => {
        expect(preparePluginResponse({ success: false, finishReason: 'error' }, '429 limit', 'test'))
            .toMatchObject({ type: 'fail', finishReason: 'error', result: '429 limit' })
    })
})
