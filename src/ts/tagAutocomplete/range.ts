export interface TagRange { start: number; end: number; query: string }

/** Offsets refer to the original textarea, including whitespace and weight delimiters. */
export function tagRange(text: string, caret: number, selectionEnd: number, scope: 'left' | 'whole'): TagRange | null {
    if (caret !== selectionEnd) return null
    let start = caret
    while (start > 0 && !/[,\r\n]/.test(text[start - 1])) start--
    let segmentEnd = caret
    while (segmentEnd < text.length && !/[,\r\n]/.test(text[segmentEnd])) segmentEnd++
    let end = segmentEnd
    const trim = () => {
        while (start < end && /\s/.test(text[start])) start++
        while (end > start && /\s/.test(text[end - 1])) end--
    }
    trim()
    // Macro/piece/variable syntax belongs to its existing editor, never to tag replacement.
    if (/[<>$]|\{\{[^}]*::|\{\{(?:char|user|bot|persona|description|personality|scenario|exampledialogue|history|lorebook)(?:\}\}|$)/i.test(text.slice(start, end))) return null
    // A weight can enclose several comma/newline-separated tags. Only remove trailing
    // delimiters known to belong to an opener before this segment, leaving tag-name punctuation intact.
    const stack: { closing: string; external: boolean }[] = []
    const outerClosings = new Map<number, string>()
    const tokens = /\\[\s\S]|[+-]?(?:\d+(?:\.\d*)?|\.\d+)::|::|[{}\[\]()]/g
    for (const match of text.slice(0, end).matchAll(tokens)) {
        const token = match[0]
        if (token.startsWith('\\')) continue
        const external = match.index < start
        if (token.endsWith('::') && token !== '::') stack.push({ closing: '::', external })
        else if ('{[('.includes(token)) stack.push({ closing: ({ '{': '}', '[': ']', '(': ')' } as Record<string, string>)[token], external })
        else if (stack.at(-1)?.closing === token) {
            if (stack.pop()!.external && !external) outerClosings.set(match.index + token.length, token)
        }
    }
    while (outerClosings.has(end)) {
        const closing = outerClosings.get(end)!
        end -= closing.length
        if (closing === ')') {
            const weight = /:[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.exec(text.slice(start, end))
            if (weight) end -= weight[0].length
        }
        trim()
    }
    let changed = true
    while (changed && start < end) {
        changed = false
        const current = text.slice(start, end)
        const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)::/.exec(current)
        if (numeric) {
            start += numeric[0].length
            if (text.slice(end - 2, end) === '::') end -= 2
            changed = true
        } else if ('{[('.includes(text[start])) {
            const closing = ({ '{': '}', '[': ']', '(': ')' } as Record<string, string>)[text[start]]
            // Strip only an outer pair (or an unfinished opener), not parentheses in a tag name.
            let depth = 0
            let firstClose = -1
            for (let i = start; i < end; i++) {
                if (text[i - 1] === '\\') continue
                if (text[i] === text[start]) depth++
                if (text[i] === closing && --depth === 0) { firstClose = i; break }
            }
            if (firstClose === -1 || firstClose === end - 1) {
                start++
                if (firstClose === end - 1) end--
                const weight = /:[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.exec(text.slice(start, end))
                if (closing === ')' && weight) end -= weight[0].length
                changed = true
            }
        }
        trim()
    }
    if (scope === 'left') end = Math.min(end, caret)
    trim()
    if (start >= end || caret < start) return null
    const query = text.slice(start, end)
    return { start, end, query }
}
