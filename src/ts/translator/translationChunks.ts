export interface TranslationPart {
    text: string
    translate: boolean
}

/** Prefer nearby line or sentence endings while bounding plaintext requests. */
export function splitTranslationText(text: string, maxCharacters: number): TranslationPart[] {
    const limit = Math.max(2, maxCharacters)
    if (text.length && text.length <= limit) return [{ text, translate: /\S/.test(text) }]
    const parts: TranslationPart[] = []
    // Syntax is not a split unit, but its contents must not be mistaken for
    // prose boundaries (for example, a period in an image URL).
    const syntax = /<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(?:"[^"]*"|'[^']*'|[^'"<>])*?>|\{\{[\s\S]*?\}\}|!\[(?:\\.|[^\]\\])*\]\((?:\\.|[^)\\])*\)|&(?:#\d+|#x[\da-f]+|[a-z][\w]+);/gi
    const boundaries = /\r\n|[\r\n]|(?:[.!?,;:]+(?=[\s"'”’»」』）)\]}*_<>]|$)|[。！？…，；：、]+)["'”’»」』）)\]}*_]*[^\S\r\n]*|[^\S\r\n]+/g
    const protectedParts = Array.from(text.matchAll(syntax), match => ({
        start: match.index,
        end: match.index + match[0].length,
    }))
    let syntaxIndex = 0
    let start = 0
    while (start < text.length) {
        let end = Math.min(start + limit, text.length)
        while (protectedParts[syntaxIndex]?.end <= start) syntaxIndex++
        let scanIndex = syntaxIndex
        while (protectedParts[scanIndex]?.end <= end) scanIndex++
        const protectedPart = protectedParts[scanIndex]
        if (protectedPart && protectedPart.start < end) {
            if (protectedPart.start === start) {
                // Preserve oversized encoded images or macros without sending
                // broken source syntax to the translator.
                parts.push({ text: text.slice(start, protectedPart.end), translate: false })
                start = protectedPart.end
                continue
            }
            end = protectedPart.start
        }
        if (end < text.length) {
            let naturalEnd = 0
            let clauseEnd = 0
            let wordEnd = 0
            scanIndex = syntaxIndex
            // One lookahead character distinguishes a sentence period from a
            // decimal point without accepting a boundary beyond the cap.
            const window = text.slice(start, end + 1)
            for (const boundary of window.matchAll(boundaries)) {
                const boundaryStart = start + boundary.index
                const boundaryEnd = Math.min(boundaryStart + boundary[0].length, end)
                if (boundaryStart >= end) break
                while (protectedParts[scanIndex]?.end <= boundaryStart) scanIndex++
                if (protectedParts[scanIndex]?.start < boundaryEnd) continue
                const first = boundary[0][0]
                if ('\r\n.!?。！？…'.includes(first)) naturalEnd = boundaryEnd
                else if (',;:，；：、'.includes(first)) clauseEnd = boundaryEnd
                else wordEnd = boundaryEnd
            }
            // A sentence longer than the cap can still end a fragment at a
            // clause or word. Only unbroken text requires a hard split.
            end = naturalEnd || clauseEnd || wordEnd || end
            if (text[end - 1] === '\r' && text[end] === '\n') end--
        }
        const before = text.charCodeAt(end - 1)
        const after = text.charCodeAt(end)
        if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--
        const fragment = text.slice(start, end)
        parts.push({ text: fragment, translate: /\S/.test(fragment) })
        start = end
    }
    return parts
}
