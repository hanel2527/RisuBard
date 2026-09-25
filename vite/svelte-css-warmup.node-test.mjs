import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { svelteCssWarmup } from './svelte-css-warmup.mjs'

test('serves Svelte CSS first, including concurrent requests after restart', { timeout: 15000 }, async () => {
    const server = await createServer({
        configFile: false,
        plugins: [svelteCssWarmup(), svelte({ preprocess: vitePreprocess() }), tailwindcss()],
        resolve: { alias: { src: '/src' } },
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { middlewareMode: true, hmr: false, preTransformRequests: false },
        logLevel: 'silent',
    })
    try {
        const url = '/src/lib/Others/BardPainterPresets.svelte?svelte&type=style&lang.css'
        const css = await server.transformRequest(url)
        assert.ok(css?.code.includes('.presets'))
        assert.ok(!css.code.includes('import type'))
        await server.restart()
        const [restartedCss, component] = await Promise.all([
            server.transformRequest(`${url}&t=1790238831385`),
            server.transformRequest('/src/lib/Others/BardPainterPresets.svelte'),
        ])
        assert.ok(restartedCss?.code.includes('.presets'))
        assert.ok(!restartedCss.code.includes('import type'))
        assert.ok(component?.code.includes('BardPainterPresets'))
    } finally { await server.close() }
})
