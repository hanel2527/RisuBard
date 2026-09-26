/** Deterministic source offsets captured once, before any generation request. */
// Retained for already-loaded dev modules during HMR. New UI uses selectionState.
export const PAINTER_OPEN_EVENT = 'risubard-bard-painter-open'

type NameSubstitutions = Partial<Record<'user' | 'char' | 'bot', string>>

export function projectPainterText(text: string, source: boolean, names: NameSubstitutions = {}) {
    const hidden = new Uint8Array(text.length)
    const substitutions = new Map<number, { length: number; value: string }>()
    if (source) {
        const syntax = /<!--[\s\S]*?-->|<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^>]*>|\{\{[\s\S]*?\}\}|!\[[^\]]*\]\([^)]*\)|\]\([^)]*\)|^[ \t]{0,3}(?:#{1,6}\s+|>\s?|[-+]\s+|\d+\.\s+)/gmi
        for (const match of text.matchAll(syntax)) {
            hidden.fill(1, match.index, match.index + match[0].length)
            const token = match[0].match(/^(?:\{\{(user|char|bot)\}\}|<(user|char|bot)>)$/i)
            if (!token) continue
            const value = names[(token[1] ?? token[2]).toLowerCase() as keyof NameSubstitutions]
            if (value !== undefined) substitutions.set(match.index, { length: match[0].length, value })
        }
    }
    let value = ''
    const map: number[] = []
    const ends: number[] = []
    for (let i = 0; i < text.length; i++) {
        const substitution = substitutions.get(i)
        if (substitution) {
            const normalized = projectPainterText(substitution.value, false).value
            value += normalized
            for (let j = 0; j < normalized.length; j++) { map.push(i); ends.push(i + substitution.length) }
            i += substitution.length - 1
            continue
        }
        if (hidden[i] || /[\s*_~`\[\]\u180e\u200b-\u200d\u2060\ufeff]/u.test(text[i])) continue
        const entity = source && text[i] === '&' ? text.slice(i).match(/^&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/i) : null
        if (entity) {
            const box = document.createElement('textarea')
            box.innerHTML = entity[0]
            const numeric = entity[0].match(/^&#(x[\da-f]+|\d+);$/i)
            const codePoint = numeric ? Number.parseInt(numeric[1].replace(/^x/i, ''), /^x/i.test(numeric[1]) ? 16 : 10) : 0
            const decoded = numeric && codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
                ? String.fromCodePoint(codePoint) : box.value
            // Offsets and strings both use UTF-16 code units, including decoded emoji.
            for (let j = 0; j < decoded.length; j++) {
                const char = decoded[j]
                if (!/\s/.test(char)) { value += char; map.push(i); ends.push(i + entity[0].length) }
            }
            i += entity[0].length - 1
            continue
        }
        value += text[i].replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
        map.push(i)
        ends.push(i + 1)
    }
    // Markdown typography collapses runs of dots. Keep the complete original span.
    for (const match of [...value.matchAll(/\.{2,}/g)].reverse()) {
        const start = match.index
        const length = match[0].length
        const end = ends[start + length - 1]
        value = value.slice(0, start) + '…' + value.slice(start + length)
        map.splice(start, length, map[start])
        ends.splice(start, length, end)
    }
    return { value, map, ends, hidden }
}

type SourceSpan = { start: number; end: number; innerStart: number; innerEnd: number }

function formattingSpans(text: string, hidden: Uint8Array): SourceSpan[] {
    const spans: SourceSpan[] = []
    for (const link of text.matchAll(/\[([^\]\n]*)\]\([^\)\n]*\)/g)) {
        if (text[link.index - 1] === '!' || hidden[link.index]) continue
        spans.push({ start: link.index, end: link.index + link[0].length, innerStart: link.index + 1, innerEnd: link.index + 1 + link[1].length })
    }
    const stack: Array<{ marker: string; count: number; start: number }> = []
    for (const run of text.matchAll(/\*+|_+|~{2,}|`+/g)) {
        if (hidden[run.index] || text[run.index - 1] === '\\') continue
        const marker = run[0][0]
        if (stack.at(-1)?.marker === '`' && marker !== '`') continue
        let remaining = run[0].length
        let cursor = run.index
        const canClose = marker === '`' || /\S/.test(text[run.index - 1] ?? '')
        while (canClose && stack.at(-1)?.marker === marker && remaining >= stack.at(-1)!.count) {
            const opened = stack.at(-1)!
            if (marker === '`' && remaining !== opened.count) break
            stack.pop()
            spans.push({ start: opened.start, end: cursor + opened.count, innerStart: opened.start + opened.count, innerEnd: cursor })
            cursor += opened.count
            remaining -= opened.count
        }
        if (remaining && /\S/.test(text[run.index + run[0].length] ?? '')) stack.push({ marker, count: remaining, start: cursor })
    }
    return spans
}

type SelectionInspection = {
    range: { start: number; end: number } | null
    issue?: 'source' | 'format' | 'empty'
}

function inspectPainterSelection(source: string, rendered: string, start: number, end: number, names: NameSubstitutions = {}): SelectionInspection {
    if (start < 0 || end <= start || end > rendered.length) return { range: null, issue: 'empty' }
    const raw = projectPainterText(source, true, names)
    const view = projectPainterText(rendered, false)
    // Never search for another occurrence: CBS and other display transformations can
    // introduce text that happens to exist at a completely different source location.
    const a = view.map.findIndex((index) => index >= start)
    let b = view.map.findIndex((index) => index >= end)
    if (b < 0) b = view.map.length
    if (a < 0 || a >= b) return { range: null, issue: 'empty' }
    // Unrelated generated footers must not invalidate an unchanged selected prefix.
    // Stop at the first mismatch; never relocate text to another occurrence.
    if (raw.value.slice(0, b) !== view.value.slice(0, b)) return { range: null, issue: 'source' }
    let from = raw.map[a]
    let to = raw.ends[b - 1]
    if (from === undefined || !Number.isFinite(to)) return { range: null, issue: 'empty' }
    for (const span of formattingSpans(source, raw.hidden)) {
        const first = raw.map.findIndex(index => index >= span.innerStart)
        let after = raw.map.findIndex(index => index >= span.innerEnd)
        if (after < 0) after = raw.map.length
        if (first < 0 || first >= after || b <= first || a >= after) continue
        if (a > first || b < after) return { range: null, issue: 'format' }
        // Expand only invisible syntax around entirely selected content, never add words.
        from = Math.min(from, span.start)
        to = Math.max(to, span.end)
    }
    return { range: { start: from, end: to } }
}

export function mapPainterSelection(source: string, rendered: string, start: number, end: number, names: NameSubstitutions = {}): { start: number; end: number } | null {
    return inspectPainterSelection(source, rendered, start, end, names).range
}

export function capturePainterSelection(root: HTMLElement, source: string, selection: Selection | null, names: NameSubstitutions = {}): (SelectionInspection & { text: string }) | null {
    if (!selection?.rangeCount || selection.isCollapsed) return null
    const selectedRange = selection.getRangeAt(0)
    const range = selectedRange.cloneRange()
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
    root = root.querySelector<HTMLElement>('[data-painter-body]') ?? root
    // Dragging through the last paragraph can leave the endpoint on the outer
    // message element. Intersect with the body instead of retaining an old scene.
    const body = document.createRange()
    body.selectNodeContents(root)
    if (range.compareBoundaryPoints(Range.START_TO_START, body) < 0) range.setStart(body.startContainer, body.startOffset)
    if (range.compareBoundaryPoints(Range.END_TO_END, body) > 0) range.setEnd(body.endContainer, body.endOffset)
    if (range.collapsed) return null
    const before = document.createRange()
    before.selectNodeContents(root)
    before.setEnd(range.startContainer, range.startOffset)
    const through = document.createRange()
    through.selectNodeContents(root)
    through.setEnd(range.endContainer, range.endOffset)
    return {
        ...inspectPainterSelection(source, root.textContent ?? '', before.toString().length, through.toString().length, names),
        // Preserve the browser's paragraph breaks unless sibling controls were clipped.
        text: range.toString() === selectedRange.toString() ? selection.toString() : range.toString(),
    }
}

export function capturePainterRange(root: HTMLElement, source: string, selection: Selection | null) {
    return capturePainterSelection(root, source, selection)?.range ?? null
}

export function insertPainterReference(source: string, anchor: { start: number; end: number }, assetId: string, side: 'before' | 'after') {
    if (!Number.isInteger(anchor.start) || !Number.isInteger(anchor.end)
        || anchor.start < 0 || anchor.end < anchor.start || anchor.end > source.length
        || !/^[\w-]+$/.test(assetId)) throw new Error('삽입 위치를 사용할 수 없습니다. 본문에서 장면을 다시 선택해 주세요.')
    const position = side === 'before' ? anchor.start : anchor.end
    const token = `\n\n{{inlay::${assetId}}}\n\n`
    return { text: source.slice(0, position) + token + source.slice(position), position, length: token.length }
}

export function shiftPainterAnchor<T extends { start: number; end: number }>(anchor: T, position: number, length: number): T {
    return { ...anchor, start: anchor.start >= position ? anchor.start + length : anchor.start,
        end: anchor.end > position ? anchor.end + length : anchor.end }
}
