import { planArcaComplexSnapshots, shouldIncludeArcaSnapshotNode } from './arcaExport';

function normalizeFontFamily(family: string): string {
    return family.trim().replace(/["']/g, '');
}

function collectUsedFontFamilies(element: HTMLElement): Set<string> {
    const families = new Set<string>();
    for (const node of [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))]) {
        for (const family of getComputedStyle(node).fontFamily.split(',')) {
            families.add(normalizeFontFamily(family));
        }
    }
    return families;
}

// html-to-image only embeds @font-face rules that load a url(). Bot fonts such as
// `src: local("Impact")` are dropped, so they are copied here as-is; local() still
// resolves inside the rendered SVG image.
export function collectLocalFontFaceCSS(
    element: HTMLElement,
    styleSheets: Iterable<CSSStyleSheet> = Array.from(element.ownerDocument.styleSheets),
): string {
    const usedFamilies = collectUsedFontFamilies(element);
    const rules: string[] = [];
    for (const sheet of styleSheets) {
        let sheetRules: CSSRuleList;
        try {
            sheetRules = sheet.cssRules;
        }
        catch {
            continue;
        }
        for (const rule of Array.from(sheetRules)) {
            if (!(rule instanceof CSSFontFaceRule)) continue;
            const source = rule.style.getPropertyValue('src');
            if (!source || /url\s*\(/i.test(source)) continue;
            if (usedFamilies.has(normalizeFontFamily(rule.style.getPropertyValue('font-family')))) {
                rules.push(rule.cssText);
            }
        }
    }
    return rules.join('\n');
}

// Arca's sanitizer strips flex, grid and position, so layout-dependent blocks
// are rasterized from the rendered DOM instead of being rebuilt as HTML.
export async function renderArcaComplexBlock(element: HTMLElement): Promise<readonly string[]> {
    const { getFontEmbedCSS, toPng } = await import('html-to-image');
    const snapshotPlan = planArcaComplexSnapshots(element);
    // Without the block's own @font-face rules the snapshot falls back to wider fonts,
    // so fixed-width labels clip or wrap. Only families the block uses are embedded.
    let fontEmbedCSS: string | undefined;
    try {
        const embedded = await getFontEmbedCSS(element, { cacheBust: false });
        fontEmbedCSS = [embedded, collectLocalFontFaceCSS(element)].filter(Boolean).join('\n');
    }
    catch (cause) {
        console.warn('Arca snapshot fonts skipped:', cause);
    }
    const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const images: string[] = [];
    const failures: unknown[] = [];

    for (const target of snapshotPlan) {
        const rect = target.element.getBoundingClientRect();
        try {
            images.push(await toPng(target.element, {
                cacheBust: false,
                pixelRatio,
                ...(fontEmbedCSS === undefined ? { skipFonts: true } : { fontEmbedCSS }),
                width: target.kind === 'panel' ? Math.min(760, Math.max(220, rect.width)) : undefined,
                filter: node => shouldIncludeArcaSnapshotNode(node, target.excludeElements),
                // The clone keeps computed margins such as `margin: 0 auto` resolved to
                // pixels, which would shift the content inside a canvas sized to the border box.
                style: target.kind === 'panel' ? {
                    margin: '0',
                    position: 'relative',
                    inset: 'auto',
                    top: 'auto',
                    right: 'auto',
                    bottom: 'auto',
                    left: 'auto',
                    transform: 'none',
                    opacity: '1',
                    visibility: 'visible',
                    pointerEvents: 'auto',
                } : { margin: '0' },
            }));
        }
        catch (cause) {
            failures.push(cause);
        }
    }
    if (images.length === 0 && failures.length > 0) throw failures[0];
    return images;
}
