import type { AdapterUsage } from '../../preset/adapter/types'

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
        result: content,
        model,
        ...(response.finishReason == null ? {} : { finishReason: response.finishReason }),
        ...(response.usage == null ? {} : { usage: response.usage }),
    }
}
