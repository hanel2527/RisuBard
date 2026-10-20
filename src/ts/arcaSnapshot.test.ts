// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { collectLocalFontFaceCSS, loadLazyImages } from './arcaSnapshot';

describe('loadLazyImages', () => {
    it('switches lazy sprites to eager loading before the snapshot', async () => {
        const block = document.createElement('div');
        block.innerHTML = '<span><img loading="lazy" alt="sprite"></span><img alt="eager">';
        // happy-dom never finishes loading images; a real browser fires load or error.
        for (const image of Array.from(block.querySelectorAll('img'))) {
            Object.defineProperty(image, 'complete', { value: true });
        }

        await loadLazyImages(block);

        expect(Array.from(block.querySelectorAll('img')).map(image => image.loading)).toEqual(['eager', 'auto']);
    });
});

describe('collectLocalFontFaceCSS', () => {
    it('keeps local-only font faces the block uses and leaves url fonts to html-to-image', () => {
        const style = document.createElement('style');
        style.textContent = [
            '@font-face{font-family:"Bot Heavy";src:local("Impact")}',
            '@font-face{font-family:"Unused Heavy";src:local("Impact")}',
            '@font-face{font-family:"Web Font";src:url("/font.woff2")}',
        ].join('\n');
        document.head.appendChild(style);
        const block = document.createElement('div');
        block.innerHTML = '<span style="font-family: \'Bot Heavy\', \'Web Font\', sans-serif">6</span>';
        document.body.appendChild(block);

        const css = collectLocalFontFaceCSS(block, [style.sheet as CSSStyleSheet]);

        expect(css).toContain('Bot Heavy');
        expect(css).not.toContain('Unused Heavy');
        expect(css).not.toContain('Web Font');
        style.remove();
        block.remove();
    });
});
