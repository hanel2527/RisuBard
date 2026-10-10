export interface TranslationPart {
    text: string
    translate: boolean
}

/** Fill plaintext requests by size, not by HTML nodes or paragraphs. */
export function splitTranslationText(text: string, maxCharacters: number): TranslationPart[] {
    const limit = Math.max(2, maxCharacters)
    const parts: TranslationPart[] = []
    // Only move a cut when it would break source syntax such as an asset ID,
    // image URL or tag attribute. Ordinary markup stays in the same request.
    const syntax = /<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(?:"[^"]*"|'[^']*'|[^'"<>])*?>|\{\{[\s\S]*?\}\}|!\[(?:\\.|[^\]\\])*\]\((?:\\.|[^)\\])*\)|&(?:#\d+|#x[\da-f]+|[a-z][\w]+);/gi
    const matches = text.matchAll(syntax)
    let protectedPart = matches.next().value
    let start = 0
    while (start < text.length) {
        let end = Math.min(start + limit, text.length)
        while (protectedPart && protectedPart.index + protectedPart[0].length <= end) {
            protectedPart = matches.next().value
        }
        if (protectedPart && protectedPart.index < end) {
            if (protectedPart.index === start) {
                // An individual encoded image or macro larger than a request
                // is not translatable prose; retain it without sending pieces.
                parts.push({ text: protectedPart[0], translate: false })
                start += protectedPart[0].length
                protectedPart = matches.next().value
                continue
            }
            end = protectedPart.index
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
