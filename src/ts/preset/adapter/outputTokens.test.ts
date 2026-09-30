import { describe, expect, test } from 'vitest'
import { resolveRisuBardChatSettings } from '../../risubard/risuBardSettings'
import { resolveDynamicMemoryBudget } from '../../risubard/dynamicMemoryBudget'
import { presetGenerationOverrides } from '../../process/request/presetResponse'
import { previewGoogleChatRequest } from './googleGemini'
import { previewChatRequest } from './openaiCompatible'
import { previewAnthropicChatRequest } from './anthropicMessages'
import type { ModelPreset } from '../types'

function preset(kind: 'google-gemini' | 'openai-compatible' | 'anthropic-messages'): ModelPreset {
    return {
        id: 'fixture', name: 'Fixture', userValues: {}, createdAt: 0, updatedAt: 0,
        profileSnapshot: {
            profileId: 'fixture:model', profileVersion: 1, providerBaseId: 'fixture', providerBaseVersion: 1,
            adapterKind: kind, auth: { kind: 'bearer', fields: ['apiKey'] },
            endpoint: { kind: 'static', url: 'https://example.invalid/v1/models' },
            modelId: 'fixture-model', schema: [], uiSchema: { groups: [], fields: [] },
            defaults: {}, capabilities: [], limits: { known: true, maxOutputTokens: 65536 },
        },
    }
}

const options = { messages: [{ role: 'user' as const, content: 'Fixture only' }] }
const credential = { apiKey: 'fixture-only' }

describe('model output ceilings', () => {
    test('caps dynamically grown Gemini analysis output without changing saved settings', async () => {
        const settings = resolveRisuBardChatSettings({ risuBardDynamicMemoryMode: 'recall', risuBardAnalysisTokenLimit: 131072 })
        const budget = resolveDynamicMemoryBudget(settings, 500000)
        const model = preset('google-gemini')
        const result = await previewGoogleChatRequest(model, { ...options,
            ...presetGenerationOverrides({ logSource: 'memory', maxTokens: budget.analysis }),
        }, credential)
        expect(result.body.generationConfig).toMatchObject({ maxOutputTokens: 65536 })
        expect(settings.risuBardAnalysisTokenLimit).toBe(131072)
        expect(model.userValues).toEqual({})
    })

    test.each([4096, 65536, 262144])('keeps lower requests and caps oversized requests: %s', async maxOutputTokens => {
        const result = await previewGoogleChatRequest(preset('google-gemini'), { ...options, maxOutputTokens }, credential)
        expect(result.body.generationConfig).toMatchObject({ maxOutputTokens: Math.min(65536, maxOutputTokens) })
    })

    test.each(['gemini-3.8-flash', 'gemini-2.5-pro'])('handles old Vertex snapshots without output metadata: %s', async modelId => {
        const model = preset('google-gemini')
        Object.assign(model.profileSnapshot, { providerBaseId: 'vertex-gemini-native', modelId, limits: undefined })
        const result = await previewGoogleChatRequest(model, { ...options, maxOutputTokens: 262144 }, credential)
        expect(result.body.generationConfig).toMatchObject({ maxOutputTokens: 65536 })
    })

    test('does not reuse another model limit when the wire model changes', async () => {
        const model = preset('google-gemini')
        model.profileSnapshot.schema = [{ key: 'modelId', type: 'string', label: 'Model', mapsTo: { target: 'body', path: 'model' } }]
        model.userValues.modelId = 'unknown-custom-model'
        const result = await previewGoogleChatRequest(model, { ...options, maxOutputTokens: 100000 }, credential)
        expect(result.body.generationConfig).toMatchObject({ maxOutputTokens: 100000 })
    })

    test('caps the mapped OpenAI completion-token field', async () => {
        const model = preset('openai-compatible')
        model.profileSnapshot.schema = [{ key: 'output', type: 'integer', label: 'Output', mapsTo: { target: 'body', path: 'max_completion_tokens' } }]
        const result = await previewChatRequest(model, { ...options, maxOutputTokens: 262144 }, credential)
        expect(result.body.max_completion_tokens).toBe(65536)
        expect(result.body.max_tokens).toBeUndefined()
    })

    test('fits Anthropic manual thinking inside the capped output budget', async () => {
        const model = preset('anthropic-messages')
        model.profileSnapshot.defaults = { thinking: { type: 'enabled', budget_tokens: 100000 } }
        const result = await previewAnthropicChatRequest(model, { ...options, maxOutputTokens: 262144 }, credential)
        expect(result.body.max_tokens).toBe(65536)
        expect(result.body.thinking).toMatchObject({ type: 'enabled', budget_tokens: 32768 })
    })
})
