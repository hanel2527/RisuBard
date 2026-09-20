import { describe, expect, it } from 'vitest'
import { diagnoseBardLoreAnalysisFailure, normalizeBardLoreAnalysisDiagnostic } from './bardLoreAnalysisDiagnostics'

describe('Grimoire failure diagnostics', () => {
    it('restores known persisted diagnostics and rejects malformed ones', () => {
        const diagnostic = diagnoseBardLoreAnalysisFailure({ error: 'invalid-json', finishReason: 'MAX_TOKENS' })
        expect(normalizeBardLoreAnalysisDiagnostic(JSON.parse(JSON.stringify(diagnostic)))).toEqual(diagnostic)
        expect(normalizeBardLoreAnalysisDiagnostic({ reason: 'invented', details: 'text' })).toBeUndefined()
        expect(normalizeBardLoreAnalysisDiagnostic({ reason: 'outputLimit', details: 42 })).toBeUndefined()
    })
    it.each(['MAX_TOKENS', 'length', 'max_tokens', 'max_output_tokens'])('identifies explicit output exhaustion: %s', (finishReason) => {
        expect(diagnoseBardLoreAnalysisFailure({ error: 'invalid-json', finishReason }).reason).toBe('outputLimit')
    })
    it.each(['SAFETY', 'content_filter', 'refusal', 'RECITATION'])('identifies provider blocking: %s', (finishReason) => {
        expect(diagnoseBardLoreAnalysisFailure({ error: 'invalid-json', finishReason }).reason).toBe('blocked')
    })
    it('reads a finish reason embedded in a plugin failure', () => {
        expect(diagnoseBardLoreAnalysisFailure({ error: '[PageFold] Structured output validation failed (finish reason: MAX_TOKENS)' }).reason).toBe('outputLimit')
    })
    it('recognizes Gemini prompt blocking without a candidate finish reason', () => {
        expect(diagnoseBardLoreAnalysisFailure({ error: 'Gemini blocked the prompt: SAFETY', responseType: 'fail' }).reason).toBe('blocked')
    })
    it('does not call a schema validation error invalid JSON', () => {
        expect(diagnoseBardLoreAnalysisFailure({ error: 'Structured output validation failed: required property entries is missing', responseType: 'fail' }).reason).toBe('validation')
    })
    it('separates context rejection, transport failure and empty successful responses', () => {
        expect(diagnoseBardLoreAnalysisFailure({ error: 'context_length_exceeded', responseType: 'fail' }).reason).toBe('inputLimit')
        expect(diagnoseBardLoreAnalysisFailure({ error: 'HTTP 429', responseType: 'fail' }).reason).toBe('requestFailed')
        expect(diagnoseBardLoreAnalysisFailure({ error: 'invalid-json', responseType: 'success', responseText: '' }).reason).toBe('empty')
    })
    it('does not infer exhaustion or censorship from malformed JSON, token counts or story text', () => {
        const result = diagnoseBardLoreAnalysisFailure({ error: 'bard-lore-analysis-invalid:invalid-json', responseType: 'success', responseText: '{"summary":"SAFETY refusal', usage: { completionTokens: 100 }, outputTokenLimit: 100, entryCount: 50 })
        expect(result.reason).toBe('invalidJson')
        expect(result.details).toContain('50')
        expect(result.details).toContain('completionTokens')
    })
    it('retains the beginning and end of long responses without storing the whole body', () => {
        const result = diagnoseBardLoreAnalysisFailure({ error: 'invalid-json', responseText: 'BEGIN' + 'x'.repeat(20_000) + 'END' })
        expect(result.details).toContain('BEGIN')
        expect(result.details).toContain('END')
        expect(result.details.length).toBeLessThan(7000)
    })
})
