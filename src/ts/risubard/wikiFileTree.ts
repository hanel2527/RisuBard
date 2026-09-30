import type { MarkdownWikiDocumentType } from './memoryWiki'
import { createEventOrder, type EventOrderMessage } from './eventOrder'

export interface WikiTreeDocumentInput {
    id: string
    title: string
    relativePath: string
    type: MarkdownWikiDocumentType
    status?: 'active' | 'superseded' | 'retracted'
    created?: string
    updated?: string
    sourceMessageIds?: readonly string[]
}

export function getRecentlyUpdatedWikiDocumentIds(
    documents: readonly WikiTreeDocumentInput[]
): Set<string> {
    const dated = documents
        .filter((document) => document.status !== 'retracted')
        .map((document) => ({ document, timestamp: Date.parse(document.updated ?? '') }))
        .filter(({ timestamp }) => Number.isFinite(timestamp))
    // Canonical pages are written separately after the analysis event is saved.
    const latestEvent = dated.reduce((latest, { document, timestamp }) =>
        document.type === 'event' ? Math.max(latest, timestamp) : latest, -Infinity)
    const since = Number.isFinite(latestEvent) ? latestEvent
        : dated.reduce((latest, { timestamp }) => Math.max(latest, timestamp), -Infinity)
    return new Set(dated.filter(({ timestamp }) => timestamp >= since)
        .map(({ document }) => document.id))
}

export type WikiFileTreeNode = {
    kind: 'folder'
    name: string
    path: string
    readOnly: boolean
    children: WikiFileTreeNode[]
} | {
    kind: 'file'
    name: string
    path: string
    readOnly: boolean
    documentId: string
    title: string
    created?: string
}

const standardWikiFolders = [
    'characters',
    'locations',
    'factions',
    'items',
    'concepts',
    'notes',
    'events',
] as const

export function buildWikiFileTree(
    documents: readonly WikiTreeDocumentInput[],
    messages?: readonly EventOrderMessage[]
): WikiFileTreeNode[] {
    const eventOrder = createEventOrder(messages)
    const documentsById = new Map(documents.map(document => [document.id, document]))
    const roots = new Map<string, WikiFileTreeNode>()
    for (const name of standardWikiFolders) {
        roots.set(name, {
            kind: 'folder',
            name,
            path: name,
            readOnly: false,
            children: [],
        })
    }
    for (const document of documents) {
        if (document.type === 'event' && document.status === 'retracted') {
            continue
        }
        const parts = document.relativePath.split('/').filter(Boolean)
        if (parts.length === 0) continue
        const readOnly = false
        if (parts.length === 1) {
            roots.set(document.relativePath, {
                kind: 'file',
                name: parts[0],
                path: document.relativePath,
                readOnly,
                documentId: document.id,
                title: document.title,
                created: document.created,
            })
            continue
        }
        const folderName = parts[0]
        const folderPath = folderName
        let folder = roots.get(folderPath)
        if (!folder || folder.kind !== 'folder') {
            folder = {
                kind: 'folder',
                name: folderName,
                path: folderPath,
                readOnly: false,
                children: [],
            }
            roots.set(folderPath, folder)
        }
        folder.children.push({
            kind: 'file',
            name: parts.at(-1) ?? document.relativePath,
            path: document.relativePath,
            readOnly,
            documentId: document.id,
            title: document.title,
            created: document.created,
        })
    }
    const order = (node: WikiFileTreeNode) => node.kind === 'file' ? 0 : 1
    const sorted = [...roots.values()].sort((left, right) =>
        order(left) - order(right) || left.name.localeCompare(right.name)
    )
    for (const node of sorted) {
        if (node.kind === 'folder') {
            node.children.sort((left, right) => {
                if (node.path === 'events'
                    && left.kind === 'file'
                    && right.kind === 'file') {
                    const chronological = eventOrder.compare(
                        documentsById.get(left.documentId)!,
                        documentsById.get(right.documentId)!, true)
                    if (chronological !== 0) return chronological
                }
                return left.name.localeCompare(right.name)
            })
        }
    }
    return sorted
}
