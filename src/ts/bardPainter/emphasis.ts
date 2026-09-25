export interface EmphasisPart {
    text: string
    weight: number
}

const bracketLog = Math.log(1.05)
const maximumLog = Math.log(Number.MAX_VALUE)
const numericWeight = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

/** Keep the source verbatim; only attach effective NovelAI weights for display. */
export function tokenizePromptEmphasis(source: string): EmphasisPart[] {
    const parts: EmphasisPart[] = []
    const tokens = /\\[\s\S]?|[+\-\d.]+|::|[{}\[\]]/g
    let base = 1
    let brackets = 0
    let cursor = 0

    function weight() {
        if (brackets === 0 || base === 0) return base
        const magnitude = Math.exp(Math.min(maximumLog, Math.log(Math.abs(base)) + brackets * bracketLog))
        return Math.sign(base) * magnitude
    }

    function append(text: string, value: number) {
        if (!text) return
        const previous = parts[parts.length - 1]
        if (previous?.weight === value) previous.text += text
        else parts.push({ text, weight: value })
    }

    for (let match = tokens.exec(source); match; match = tokens.exec(source)) {
        append(source.slice(cursor, match.index), weight())
        let token = match[0]

        if (/^[+\-\d.]/.test(token) && source.slice(tokens.lastIndex, tokens.lastIndex + 2) === '::') {
            const valid = numericWeight.test(token) && !/[+\-\d.]/.test(source[match.index - 1] ?? '')
            if (valid) {
                const parsed = Number(token)
                base = Number.isFinite(parsed) ? parsed : Math.sign(parsed) * Number.MAX_VALUE
                brackets = 0
            }
            token += '::'
            tokens.lastIndex += 2
            append(token, weight())
        } else if (token === '::') {
            append(token, weight())
            base = 1
            brackets = 0
        } else if (token === '{' || token === '[') {
            brackets += token === '{' ? 1 : -1
            append(token, weight())
        } else if (token === '}' || token === ']') {
            append(token, weight())
            brackets += token === ']' ? 1 : -1
        } else {
            append(token, weight())
        }
        cursor = tokens.lastIndex
    }
    append(source.slice(cursor), weight())
    return parts
}

export function emphasisAppearance(weight: number): { tone: 'strong' | 'weak' | 'neutral'; opacity: number } {
    if (weight === 1 || Number.isNaN(weight)) return { tone: 'neutral', opacity: 0 }
    const distance = Math.abs(weight - 1)
    return {
        tone: weight > 1 ? 'strong' : 'weak',
        opacity: Math.min(.42, .08 + .34 * (1 - Math.exp(-distance))),
    }
}
