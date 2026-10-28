import { build } from 'vite';
import { fileURLToPath } from 'node:url';

// No app build/config and no remote runtime dependencies: import the resulting single JS file.
await build({
    configFile: false,
    publicDir: false,
    build: {
        target: 'es2022',
        outDir: fileURLToPath(new URL('../', import.meta.url)),
        emptyOutDir: false,
        minify: false,
        lib: {
            entry: fileURLToPath(new URL('./index.js', import.meta.url)),
            name: 'RisuBardTranslationViewer',
            formats: ['iife'],
            fileName: () => 'translation-viewer.js',
        },
        rollupOptions: {
            output: {
                banner: [
                    '//@name risubard-translation-viewer',
                    '//@display-name 원문 보존 번역',
                    '//@api 3.0',
                    '//@version 1.3.0',
                    '// 1.3.0: Journal originals before temporary native display processing; cache rendered HTML/assets, restore before automatic wiki, recover interrupted swaps on startup.',
                    '// Built from plugin/translation-viewer/; rebuild with node plugin/translation-viewer/build.mjs.',
                ].join('\n'),
            },
        },
    },
});
