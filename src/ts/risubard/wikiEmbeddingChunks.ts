/** Offsets are UTF-16 indexes into the exact canonical Markdown content. */
export interface WikiEmbeddingChunk {
    documentId: string
    contentHash: string
    text: string
    start: number
    end: number
}

export interface WikiEmbeddingCatalog {
    revision: string
    chunks: WikiEmbeddingChunk[]
    nextOffset: number | null
}

export function chunkWikiDocument(document: {
    id: string; contentHash: string; title: string; content: string
}): WikiEmbeddingChunk[] {
    const chunks: WikiEmbeddingChunk[] = []
    let heading = ''
    // Headings and blank lines delimit passages, without truncating the document.
    const passages = document.content.matchAll(/[^\r\n]+(?:\r?\n(?!\r?\n|#{1,6}\s)[^\r\n]+)*/g)
    for (const passage of passages) {
        const value = passage[0]
        if (/^#{1,6}\s/.test(value)) heading = value.split(/\r?\n/)[0]
        const prefix = [document.title.slice(0, 200), heading.slice(0, 200)].filter(Boolean).join('\n') + '\n\n'
        const limit = 1000 - prefix.length
        for (let offset = 0; offset < value.length;) {
            const end = Math.min(value.length, offset + limit)
            chunks.push({ documentId: document.id, contentHash: document.contentHash,
                text: prefix + value.slice(offset, end),
                start: passage.index! + offset, end: passage.index! + end })
            if (end === value.length) break
            offset = end - 120
        }
    }
    return chunks
}
