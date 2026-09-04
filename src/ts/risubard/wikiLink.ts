import type MarkdownIt from 'markdown-it'
import type { NarrativeMemoryWikiMarkdown } from './memoryWiki'

type WikiDocument = NarrativeMemoryWikiMarkdown['documents'][number]

/** Longest `[[…]]` target or alias the parser will accept. */
const MAX_WIKILINK_LENGTH = 160

export function normalizeWikiLinkKey(value: string): string {
    return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

/** Resolves a `[[target]]` only when one loaded document owns the identifier. */
export function resolveWikiLinkTarget(
    target: string,
    documents: readonly WikiDocument[]
): WikiDocument | null {
    const wanted = normalizeWikiLinkKey(target)
    if (!wanted) return null
    let match: WikiDocument | null = null
    for (const document of documents) {
        const ownsIdentifier = [document.title, ...(document.aliases ?? [])]
            .some((value) => normalizeWikiLinkKey(value) === wanted)
        if (!ownsIdentifier) continue
        if (match && match.id !== document.id) return null
        match = document
    }
    return match
}

export interface WikiLinkPluginOptions {
    /** Reports whether a target resolves, so unresolved links can be styled. */
    resolves?: (target: string) => boolean
}

/**
 * markdown-it plugin rendering Obsidian-style `[[Target]]` and
 * `[[Target|Label]]` as anchors carrying `data-wikilink`.
 *
 * Registered as an inline rule rather than a post-render string replacement so
 * that code spans and fenced blocks are left alone by the tokenizer itself.
 */
export function wikiLinkPlugin(
    md: MarkdownIt,
    options: WikiLinkPluginOptions = {}
): void {
    md.inline.ruler.before('link', 'wikilink', (state, silent) => {
        const start = state.pos
        const source = state.src
        if (source.charCodeAt(start) !== 0x5B /* [ */
            || source.charCodeAt(start + 1) !== 0x5B) return false

        const close = source.indexOf(']]', start + 2)
        if (close < 0) return false

        const body = source.slice(start + 2, close)
        if (!body || body.includes('\n') || body.includes('[')) return false

        const separator = body.indexOf('|')
        const target = (separator < 0 ? body : body.slice(0, separator)).trim()
        const label = (separator < 0 ? body : body.slice(separator + 1)).trim()
        if (!target || !label
            || target.length > MAX_WIKILINK_LENGTH
            || label.length > MAX_WIKILINK_LENGTH) return false

        // Let markdown-it scan nested brackets itself while finding the label
        // boundary of an ordinary Markdown link.
        if (silent) return false

        const linkLevel = (state as typeof state & { linkLevel:number }).linkLevel
        if (linkLevel > 0) {
            const text = state.push('text', '', 0)
            text.content = source.slice(start, close + 2)
            state.pos = close + 2
            return true
        }

        const unresolved = options.resolves?.(target) === false
        const open = state.push('wikilink_open', 'a', 1)
        open.attrSet('data-wikilink', target)
        open.attrSet('class', unresolved
            ? 'wikilink wikilink-unresolved'
            : 'wikilink')
        // An anchor without href is not focusable, so links would be
        // unreachable by keyboard. Unresolved targets stay out of the tab
        // order because activating them does nothing.
        if (!unresolved) {
            open.attrSet('role', 'link')
            open.attrSet('tabindex', '0')
        }
        const text = state.push('text', '', 0)
        text.content = label
        state.push('wikilink_close', 'a', -1)
        state.pos = close + 2
        return true
    })
}
