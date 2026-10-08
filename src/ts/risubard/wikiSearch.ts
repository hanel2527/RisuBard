// Shared by the wiki editor and the server search route so both match the same way.
export function normalizeWikiSearchText(value: string): string {
    return value.normalize('NFKC').toLocaleLowerCase()
}

export function matchesWikiSearch(document: {
    title: string
    aliases?: readonly string[]
    relativePath: string
    content: string
}, query: string): boolean {
    if (!query) return true
    return normalizeWikiSearchText([
        document.title,
        ...(document.aliases ?? []),
        document.relativePath,
        document.content,
    ].join('\n')).includes(normalizeWikiSearchText(query))
}
