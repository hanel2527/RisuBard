import { describe, expect, it } from 'vitest'
import { normalizePluginJsonResponse, normalizePluginJsonStream, preparePluginResponse } from './pluginResponse'

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

describe('plugin JSON compatibility', () => {
    const damaged = '{"subjects":[{"prompt":"blue hair\n\nwhite dress"}]}'

    it('restores Pagefold-style decoded newlines at the shared plugin boundary', () => {
        const response = preparePluginResponse({ success: true }, damaged, 'pluginmodel:::pagefold-gemini')
        expect(JSON.parse(response.result)).toEqual({ subjects: [{ prompt: 'blue hair\n\nwhite dress' }] })
        expect(response.result).toBe('{"subjects":[{"prompt":"blue hair\\n\\nwhite dress"}]}')
    })

    it('also restores multiline wiki fields, arrays and escaped controls within fenced JSON', () => {
        const text = '<think>reasoning</think>\n```json\n[ {"markdown":"# Title\r\nText\tend", "literal":"slash\\n"} ]\n```'
        const output = normalizePluginJsonResponse(text)
        expect(output).toBe('<think>reasoning</think>\n```json\n[ {"markdown":"# Title\\r\\nText\\tend", "literal":"slash\\n"} ]\n```')
    })

    it.each([
        '{"text":"already escaped\\n\\t\\r", "quote":"\\\"", "path":"C:\\\\new"}',
        'ordinary\nmultiline\ttext',
        'Before {"text":"broken\nJSON"} after',
        '{"text":"cut off\n',
        '{"text":"raw\ncontrol",}',
        '{"text":"raw\ncontrol"} {"second":true}',
        '<think>unfinished {"text":"raw\ncontrol"}',
        '{"text":"quote " is broken\n"}',
    ])('leaves valid output, prose and unrelated damage unchanged: %s', text => {
        expect(normalizePluginJsonResponse(text)).toBe(text)
    })

    it('preserves literal backslash sequences after a plugin decodes the final slash-n', () => {
        const original = JSON.stringify({ text: 'literal \\n and newline\n한글 日本語' })
        expect(normalizePluginJsonResponse(original.replace(/\\n/g, '\n'))).toBe(original)
    })

    it('never repairs a failed provider response', () => {
        expect(preparePluginResponse({ success: false }, damaged, 'pagefold').result).toBe(damaged)
    })

    it('corrects the final streaming snapshot while forwarding partial text unchanged', async () => {
        const snapshots = [{ '0': damaged.slice(0, 24) }, { '0': damaged }]
        const stream = new ReadableStream({ start(controller) { for (const value of snapshots) controller.enqueue(value); controller.close() } })
        const reader = normalizePluginJsonStream(stream).getReader()
        const received = []
        while (true) { const { done, value } = await reader.read(); if (done) break; received.push(value) }
        expect(received.slice(0, 2)).toEqual(snapshots)
        expect(JSON.parse(received[2]['0'])).toEqual({ subjects: [{ prompt: 'blue hair\n\nwhite dress' }] })
    })

    it('propagates stream errors instead of turning interrupted text into a successful JSON result', async () => {
        const stream = new ReadableStream<Record<string, string>>({ start(controller) { controller.error(new Error('interrupted')) } })
        await expect(normalizePluginJsonStream(stream).getReader().read()).rejects.toThrow('interrupted')
    })
})
