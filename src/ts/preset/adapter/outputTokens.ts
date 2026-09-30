import type { ModelPreset } from '../types'
import { loadBundledRegistry } from '../registry/loader'
import { resolveWireModelId } from './wireInvariants'

/** Clamp the per-request output override, never the persisted user baseline. */
export function capModelOutputTokens(preset: ModelPreset, requested: number): number {
    const snapshot = preset.profileSnapshot
    const modelId = resolveWireModelId(preset)
    const valid = (value: unknown): value is number =>
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    if (modelId === snapshot.modelId && snapshot.limits?.known !== false
        && valid(snapshot.limits?.maxOutputTokens)) {
        return Math.min(requested, snapshot.limits.maxOutputTokens)
    }
    // Old presets can predate limit metadata. Match the actual model, not just
    // the profile ID. Native Vertex Gemini also uses Google's model limits.
    const providers = new Set([snapshot.providerBaseId])
    if (snapshot.adapterKind === 'google-gemini'
        && snapshot.providerBaseId === 'vertex-gemini-native') providers.add('google')
    const limits: number[] = []
    for (const registry of Object.values(loadBundledRegistry().registries)) {
        for (const profile of Object.values(registry.profiles)) {
            if (providers.has(profile.providerBaseId) && profile.modelId === modelId
                && profile.limits?.known !== false && valid(profile.limits?.maxOutputTokens)) {
                limits.push(profile.limits.maxOutputTokens)
            }
        }
    }
    // Unknown custom deployments retain their configured budget.
    return Math.min(requested, ...limits)
}
