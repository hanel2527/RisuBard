import type { fetchNative, globalFetch } from '../globalApi.svelte'

/** Opt in only at the plugin boundary, not for unrelated internal transports. */
export function createPluginFetchLogging(pluginName: string, transports: {
    nativeFetch: typeof fetchNative
    risuFetch: typeof globalFetch
}) {
    const defaults = { logCategory: 'other' as const, logSource: 'plugin' as const, logModel: pluginName }
    return {
        nativeFetch: ((url, options) => transports.nativeFetch(url, { ...defaults, ...options })) as typeof fetchNative,
        risuFetch: ((url, options) => transports.risuFetch(url, { ...defaults, ...options })) as typeof globalFetch,
    }
}
