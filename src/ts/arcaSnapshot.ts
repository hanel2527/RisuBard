import { planArcaComplexSnapshots, shouldIncludeArcaSnapshotNode } from './arcaExport';

// Arca's sanitizer strips flex, grid and position, so layout-dependent blocks
// are rasterized from the rendered DOM instead of being rebuilt as HTML.
export async function renderArcaComplexBlock(element: HTMLElement): Promise<readonly string[]> {
    const { toPng } = await import('html-to-image');
    const snapshotPlan = planArcaComplexSnapshots(element);
    const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const images: string[] = [];
    const failures: unknown[] = [];

    for (const target of snapshotPlan) {
        const rect = target.element.getBoundingClientRect();
        try {
            images.push(await toPng(target.element, {
                cacheBust: false,
                pixelRatio,
                skipFonts: true,
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
