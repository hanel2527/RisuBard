/**
 * A browser can request a cached component's CSS before its JS after dev restart.
 * vite-plugin-svelte 7 reads that CSS from the parent module's compile metadata;
 * without it, loading falls through to the original .svelte source as CSS.
 * Compile the parent first and leave CSS generation and HMR to the Svelte plugin.
 * @returns {import('vite').Plugin}
 */
export function svelteCssWarmup() {
    return {
        name: 'risubard-svelte-css-warmup',
        apply: 'serve',
        enforce: 'pre',
        load: {
            filter: { id: /\.svelte\?.*\btype=style\b/ },
            async handler(id) {
                if (this.environment.config.consumer !== 'client') return
                const [filename, query] = id.split('?', 2)
                const params = new URLSearchParams(query)
                if (!params.has('svelte') || params.has('raw') || params.has('direct')) return
                if (!this.getModuleInfo(filename)?.meta.svelte?.css) {
                    await this.environment.transformRequest(`/@fs/${filename}`)
                }
            },
        },
    }
}
