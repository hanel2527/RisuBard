import MarkdownIt from 'markdown-it'
import { projectPainterText } from './selection'

export type PainterParagraphStop = { offset: number | null; top: number; left: number; width: number }
type Names = Partial<Record<'user' | 'char' | 'bot', string>>
type DisplayBlock = { range: Range; element?: HTMLElement }
type SourceBlock = { start: number; end: number }

const markdown = new MarkdownIt({ html: true })
const atomicBlocks = /^(P|BLOCKQUOTE|UL|OL|PRE|TABLE|H[1-6]|HR|FIGURE|IMG)$/

function htmlSourceBlocks(source: string, start: number, end: number) {
    type Frame = { tag: string; start: number; hidden: boolean; children: SourceBlock[] }
    const result: SourceBlock[] = [], stack: Frame[] = []
    const append = (parts: SourceBlock[]) => (stack.at(-1)?.children ?? result).push(...parts)
    const finish = (frame: Frame, through: number) => {
        if (frame.hidden) return
        if (atomicBlocks.test(frame.tag)) { append([{ start: frame.start, end: through }]); return }
        if (frame.children.length) { append(frame.children); return }
        if (/^(DIV|SECTION|ARTICLE|ASIDE|HEADER|FOOTER)$/.test(frame.tag)
            && source.slice(frame.start, through).replace(/<!--[\s\S]*?-->|<[^>]*>/g, '').trim()) {
            append([{ start: frame.start, end: through }])
        }
    }
    // Keep original offsets. DOMParser cannot report tag positions, and searching
    // for rendered text would choose the wrong occurrence in repeated paragraphs.
    const tags = /<!--[\s\S]*?-->|<\/?([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi
    let continuedAtomic = false, throughEnd = end
    for (const match of source.slice(start).matchAll(tags)) {
        if (!match[1]) continue
        const tag = match[1].toUpperCase(), at = start + match.index, through = at + match[0].length
        if (at >= end) {
            // markdown-it's generic HTML blocks end at a blank line, even when
            // that line is inside a nested <pre> or list. Never cut those blocks.
            continuedAtomic ||= stack.some(frame => !frame.hidden && atomicBlocks.test(frame.tag))
            if (!continuedAtomic || !stack.length) break
        }
        throughEnd = Math.max(throughEnd, through)
        if (match[0].startsWith('</')) {
            const index = stack.findLastIndex(frame => frame.tag === tag)
            if (index >= 0) while (stack.length > index) finish(stack.pop()!, through)
            continue
        }
        const frame: Frame = { tag, start: at, children: [], hidden: !!stack.at(-1)?.hidden || /^(STYLE|SCRIPT|TEMPLATE)$/.test(tag) || /\shidden(?:\s|=|>)/i.test(match[0]) }
        if (/^(AREA|BASE|BR|COL|EMBED|HR|IMG|INPUT|LINK|META|PARAM|SOURCE|TRACK|WBR)$/.test(tag) || /\/>$/.test(match[0])) finish(frame, through)
        else stack.push(frame)
    }
    if (stack.some(frame => !frame.hidden && atomicBlocks.test(frame.tag))) throughEnd = source.length
    while (stack.length) finish(stack.pop()!, throughEnd)
    return { blocks: result, end: throughEnd }
}

function sourceBlocks(source: string) {
    const lines = [0]
    for (const match of source.matchAll(/\r\n|\r|\n/g)) lines.push(match.index + match[0].length)
    const blocks: SourceBlock[] = []
    let through = 0
    for (const token of markdown.parse(source, {})) {
        if (token.level !== 0 || token.nesting === -1 || !token.map) continue
        const block = { start: lines[token.map[0]] ?? source.length, end: lines[token.map[1]] ?? source.length }
        if (block.start < through) continue
        if (token.type === 'html_block') {
            const html = htmlSourceBlocks(source, block.start, block.end)
            blocks.push(...html.blocks); through = html.end
        } else { blocks.push(block); through = block.end }
    }
    return blocks
}

function visibleText(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (node instanceof HTMLElement && (node.hidden || /^(STYLE|SCRIPT|TEMPLATE|BUTTON)$/.test(node.tagName) || getComputedStyle(node).display === 'none')) return ''
    return [...node.childNodes].map(visibleText).join('')
}

/** Match paragraphs locally, preserving order and refusing ambiguous duplicates. */
function matchBlocks(source: string[], displayed: string[]) {
    const indices = displayed.map(() => -1)
    const regions = [{ a: 0, b: source.length, x: 0, y: displayed.length }]
    const occurrences = (values: string[], start: number, end: number) => {
        const found = new Map<string, number[]>()
        for (let index = start; index < end; index++) if (values[index]) {
            const entries = found.get(values[index]) ?? []
            entries.push(index); found.set(values[index], entries)
        }
        return found
    }
    while (regions.length) {
        const { a, b, x, y } = regions.pop()!
        if (a === b || x === y) continue
        const raw = occurrences(source, a, b), view = occurrences(displayed, x, y)
        const pairs: Array<{ source: number; display: number }> = []
        for (let index = x; index < y; index++) {
            const matches = raw.get(displayed[index])
            if (matches?.length === 1 && view.get(displayed[index])?.length === 1) pairs.push({ source: matches[0], display: index })
        }
        // A crossing pair means the renderer reordered content. Do not turn that
        // into an ordinal match, even if both sides have the same paragraph count.
        const suffixMinimum = new Array<number>(pairs.length + 1).fill(Infinity)
        for (let index = pairs.length - 1; index >= 0; index--) suffixMinimum[index] = Math.min(pairs[index].source, suffixMinimum[index + 1])
        let previousMaximum = -1
        const anchors = pairs.filter((pair, index) => {
            const safe = pair.source > previousMaximum && pair.source < suffixMinimum[index + 1]
            previousMaximum = Math.max(previousMaximum, pair.source)
            return safe
        })
        if (anchors.length) {
            let fromSource = a, fromDisplay = x
            for (const anchor of anchors) {
                regions.push({ a: fromSource, b: anchor.source, x: fromDisplay, y: anchor.display })
                indices[anchor.display] = anchor.source
                fromSource = anchor.source + 1; fromDisplay = anchor.display + 1
            }
            regions.push({ a: fromSource, b, x: fromDisplay, y })
        } else if (b - a === y - x) {
            const compatible = displayed.slice(x, y).every((value, index) => value === source[a + index]
                || (!raw.has(value) && !view.has(source[a + index])))
            if (compatible) for (let index = x; index < y; index++) indices[index] = a + index - x
        }
    }
    return indices
}

function displayBlocks(root: HTMLElement): DisplayBlock[] {
    const blocks: DisplayBlock[] = []
    let pending: Range | undefined
    const flush = () => {
        if (pending?.toString().trim()) blocks.push({ range: pending })
        pending = undefined
    }
    const addText = (node: Text, start: number, end: number) => {
        if (start === end) return
        if (!pending) { pending = document.createRange(); pending.setStart(node, start) }
        pending.setEnd(node, end)
    }
    const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node as Text
            let start = 0
            for (const gap of text.data.matchAll(/(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)/g)) {
                addText(text, start, gap.index)
                flush()
                start = gap.index + gap[0].length
            }
            addText(text, start, text.length)
            return
        }
        if (!(node instanceof HTMLElement)) return
        if (node.hidden || /^(SCRIPT|STYLE|BUTTON)$/.test(node.tagName) || getComputedStyle(node).display === 'none') return
        if (atomicBlocks.test(node.tagName)) {
            flush()
            const range = document.createRange()
            range.selectNodeContents(node)
            blocks.push({ range, element: node })
            return
        }
        if (node.tagName === 'BR') { flush(); return }
        const wrapper = node.tagName === 'DIV'
        if (wrapper) flush()
        for (const child of node.childNodes) walk(child)
        if (wrapper) flush()
    }
    for (const child of root.childNodes) walk(child)
    flush()
    return blocks
}

function blockRect(block: DisplayBlock, fallback: DOMRect) {
    const elementRect = block.element?.getBoundingClientRect()
    if (elementRect && (elementRect.width || elementRect.height)) return elementRect
    const rangeRect = block.range.getBoundingClientRect()
    return rangeRect.width || rangeRect.height ? rangeRect : fallback
}

/** Client-space gaps at safe Markdown block boundaries, without rewriting the source. */
export function getPainterParagraphStops(root: HTMLElement, source: string, names: Names = {}): PainterParagraphStop[] {
    root = root.querySelector<HTMLElement>('[data-painter-body]') ?? root
    const sourceParts = sourceBlocks(source)
    const displayed = displayBlocks(root)
    const rootRect = root.getBoundingClientRect()
    const rects = displayed.map(block => blockRect(block, rootRect))
    const first = rects[0] ?? rootRect
    const last = rects.at(-1) ?? rootRect
    const stops: PainterParagraphStop[] = [{ offset: 0, top: first.top, left: first.left, width: first.width }]
    const indices = matchBlocks(
        sourceParts.map(part => projectPainterText(source.slice(part.start, part.end), true, names).value),
        displayed.map(block => projectPainterText(visibleText(block.element ?? block.range.cloneContents()), false).value),
    )
    for (let index = 1; index < displayed.length; index++) {
        const before = indices[index - 1]
        const after = indices[index]
        const upper = rects[index - 1]
        const lower = rects[index]
        const left = Math.min(upper.left, lower.left)
        stops.push({ offset: before >= 0 && after > before ? sourceParts[after].start : null,
            top: (upper.bottom + lower.top) / 2, left, width: Math.max(upper.right, lower.right) - left })
    }
    if (source.length) stops.push({ offset: source.length, top: last.bottom, left: last.left, width: last.width })
    return stops
}

export function nearestPainterParagraphStop(stops: PainterParagraphStop[], clientY: number): PainterParagraphStop | undefined {
    if (!Number.isFinite(clientY)) return undefined
    let nearest: PainterParagraphStop | undefined
    for (const stop of stops) {
        if (Number.isFinite(stop.top) && (!nearest || Math.abs(stop.top - clientY) < Math.abs(nearest.top - clientY))) nearest = stop
    }
    return nearest
}
