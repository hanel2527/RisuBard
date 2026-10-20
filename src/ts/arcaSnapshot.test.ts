// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { collectLocalFontFaceCSS } from './arcaSnapshot';

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
