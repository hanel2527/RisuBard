import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const rendererRequire = createRequire(require.resolve('markdown-it/package.json'));
const licenses = ['markdown-it', 'entities', 'linkify-it', 'mdurl', 'punycode.js', 'uc.micro'].map(name => {
    let directory = dirname(rendererRequire.resolve(name));
    while (directory !== dirname(directory)) {
        const manifest = join(directory, 'package.json');
        if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) {
            const license = readdirSync(directory).find(file => /^licen[sc]e(?:[.-]|$)/i.test(file));
            if (!license) throw new Error(`Missing bundled license: ${name}`);
            return `${name}\n${readFileSync(join(directory, license), 'utf8')}`;
        }
        directory = dirname(directory);
    }
    throw new Error(`Cannot locate bundled package: ${name}`);
}).join('\n\n').replaceAll('*/', '* /');

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
                    '//@version 1.1.0',
                    '// Bundled renderer licenses follow.',
                    `/*\n${licenses}\n*/`,
                    '// Built from plugin/translation-viewer/; rebuild with node plugin/translation-viewer/build.mjs.',
                ].join('\n'),
            },
        },
    },
});
