import type { AdapterUsage } from '../../preset/adapter/types'
import { stripModelReasoning } from '../../../../packages/risubard-core/src/modelOutput'

/** Some plugins (including Pagefold) decode JSON escapes before returning text.
 * Restore only raw string controls in a complete JSON document. Never guess at
 * missing delimiters, change valid JSON, or salvage an object from prose.
 */
export function normalizePluginJsonResponse(content: string): string {
    const remaining = stripModelReasoning(content)
    const fence = remaining.match(/^(\s*```(?:json)?[ \t]*\r?\n)([\s\S]*?)(\r?\n```\s*)$/i)
    const source = fence ? fence[2] : remaining
    if (!/^\s*[\[{]/.test(source)) return content
    try { JSON.parse(source); return content } catch { /* Check the one known recoverable corruption below. */ }
    let inString = false, escaped = false, changed = false
    let repaired = ''
    for (const character of source) {
        if (inString && character.charCodeAt(0) < 0x20) {
            repaired += JSON.stringify(character).slice(1, -1)
            // Also restores a literal backslash-n that became backslash + LF.
            escaped = false
            changed = true
            continue
        }
        repaired += character
        if (inString) {
            if (escaped) escaped = false
            else if (character === '\\') escaped = true
            else if (character === '"') inString = false
        } else if (character === '"') inString = true
    }
    if (!changed) return content
    try { JSON.parse(repaired) } catch { return content }
    const prefix = content.slice(0, content.length - remaining.length)
    return prefix + (fence ? fence[1] + repaired + fence[3] : repaired)
}

/** Cumulative plugin snapshots stay live; only successful completion emits a
 * corrected final snapshot. Errors and cancellation retain stream semantics.
 */
export function normalizePluginJsonStream(stream: ReadableStream<Record<string, string>>) {
    let last: Record<string, string> | undefined
    return stream.pipeThrough(new TransformStream<Record<string, string>, Record<string, string>>({
        transform(chunk, controller) { last = chunk; controller.enqueue(chunk) },
        flush(controller) {
            if (!last) return
            const normalized = Object.fromEntries(Object.entries(last).map(([key, value]) => [key, normalizePluginJsonResponse(value)]))
            if (Object.keys(last).some(key => last![key] !== normalized[key])) controller.enqueue(normalized)
        },
    }))
}

/** Optional provider metadata remains unknown when a legacy plugin omits it. */
export interface PluginResponseMetadata {
    finishReason?: string
    usage?: AdapterUsage
}

export function preparePluginResponse(
    response: { success: boolean } & PluginResponseMetadata,
    content: string,
    model: string,
) {
    return {
        type: response.success ? 'success' as const : 'fail' as const,
        result: response.success ? normalizePluginJsonResponse(content) : content,
        model,
        ...(response.finishReason == null ? {} : { finishReason: response.finishReason }),
        ...(response.usage == null ? {} : { usage: response.usage }),
    }
}
