export interface TranslationPart {
    text: string
    translate: boolean
}

/** Keep source markup out of independently translated fragments. */
export function splitTranslationText(text: string, maxCharacters: number): TranslationPart[] {
    if (text.length <= maxCharacters) return [{ text, translate: true }]

    const parts: TranslationPart[] = []
    // Preserve code, markup and CBS verbatim; splitting a tag or asking the model
    // to repair an incomplete HTML fragment can change the message's layout.
    const protectedData = /<!--[\s\S]*?-->|<(script|style|pre|code|risu-style|style-data)\b(?:"[^"]*"|'[^']*'|[^'">])*?>[\s\S]*?<\/\1\s*>|(?:^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2(?=\n|$)|`[^`\r\n]+`|<\/?[a-z][\w:-]*(?:"[^"]*"|'[^']*'|[^'"<>])*?>|\{\{[\s\S]*?\}\}|&(?:#\d+|#x[\da-f]+|[a-z][\w]+);/gi

    const literal = (value: string) => {
        if (!value) return
        const previous = parts[parts.length - 1]
        if (previous && !previous.translate) previous.text += value
        else parts.push({ text: value, translate: false })
    }

    const appendText = (value: string) => {
        let start = 0
        while (start < value.length) {
            let end = Math.min(start + maxCharacters, value.length)
            if (end < value.length) {
                const window = value.slice(start, end)
                const paragraph = window.lastIndexOf('\n\n')
                const line = window.lastIndexOf('\n')
                if (paragraph >= 0) end = start + paragraph + 2
                else if (line >= 0) end = start + line + 1
                else {
                    let sentenceEnd = 0
                    for (const sentence of window.matchAll(/[.!?。！？]["'”’\])]*\s+/g)) {
                        sentenceEnd = sentence.index + sentence[0].length
                    }
                    if (sentenceEnd) end = start + sentenceEnd
                    else {
                        const spaces = /(\s+)\S*$/.exec(window)
                        if (spaces) end = start + spaces.index + spaces[1].length
                    }
                }
                // A hard split must not separate UTF-16 surrogate pairs.
                const before = value.charCodeAt(end - 1)
                const after = value.charCodeAt(end)
                if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--
                if (end <= start) end = Math.min(start + 2, value.length)
            }

            const fragment = value.slice(start, end)
            const content = /^(\s*)([\s\S]*?\S)(\s*)$/.exec(fragment)
            if (content) {
                literal(content[1])
                parts.push({ text: content[2], translate: true })
                literal(content[3])
            } else literal(fragment)
            start = end
        }
    }

    let start = 0
    for (const protectedPart of text.matchAll(protectedData)) {
        appendText(text.slice(start, protectedPart.index))
        literal(protectedPart[0])
        start = protectedPart.index + protectedPart[0].length
    }
    appendText(text.slice(start))
    return parts
}
