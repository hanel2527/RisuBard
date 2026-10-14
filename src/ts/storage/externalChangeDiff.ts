// Line diff for the external change review dialog.

export interface DiffLine {
    type: 'same' | 'add' | 'del' | 'skip'
    text: string
}

const MAX_CELLS = 2_000_000

/**
 * Line diff with common prefix/suffix trimming and an LCS core. Very large
 * middles fall back to "all removed, then all added". Unchanged runs longer
 * than `context * 2` collapse into a skip marker.
 */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
    const a = before.split('\n')
    const b = after.split('\n')
    let start = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start++
    let endA = a.length
    let endB = b.length
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
    const midA = a.slice(start, endA)
    const midB = b.slice(start, endB)
    const middle: DiffLine[] = []
    if (midA.length * midB.length > MAX_CELLS) {
        for (const text of midA) middle.push({ type: 'del', text })
        for (const text of midB) middle.push({ type: 'add', text })
    } else {
        const rows = midA.length + 1
        const cols = midB.length + 1
        const table = new Uint32Array(rows * cols)
        for (let i = midA.length - 1; i >= 0; i--) {
            for (let j = midB.length - 1; j >= 0; j--) {
                table[i * cols + j] = midA[i] === midB[j]
                    ? table[(i + 1) * cols + j + 1] + 1
                    : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
            }
        }
        let i = 0
        let j = 0
        while (i < midA.length && j < midB.length) {
            if (midA[i] === midB[j]) { middle.push({ type: 'same', text: midA[i] }); i++; j++ }
            else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) middle.push({ type: 'del', text: midA[i++] })
            else middle.push({ type: 'add', text: midB[j++] })
        }
        while (i < midA.length) middle.push({ type: 'del', text: midA[i++] })
        while (j < midB.length) middle.push({ type: 'add', text: midB[j++] })
    }
    const lines: DiffLine[] = [
        ...a.slice(0, start).map(text => ({ type: 'same' as const, text })),
        ...middle,
        ...a.slice(endA).map(text => ({ type: 'same' as const, text })),
    ]
    return collapse(lines, context)
}

function collapse(lines: DiffLine[], context: number): DiffLine[] {
    const changed = lines.map(line => line.type !== 'same')
    const keep = lines.map((_, index) => {
        for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) if (changed[k]) return true
        return false
    })
    const out: DiffLine[] = []
    let skipped = 0
    lines.forEach((line, index) => {
        if (keep[index]) {
            if (skipped) out.push({ type: 'skip', text: String(skipped) })
            skipped = 0
            out.push(line)
        } else skipped++
    })
    if (skipped) out.push({ type: 'skip', text: String(skipped) })
    return out
}
