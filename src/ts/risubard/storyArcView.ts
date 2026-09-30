import type { NarrativeMemoryWikiMarkdown } from './memoryWiki'
import { isStoryArcTitle } from './wikiWritingLanguage'
import { createEventOrder, hasOnlyInheritedSources, type EventOrderMessage } from './eventOrder'

type WikiDocument = NarrativeMemoryWikiMarkdown['documents'][number]

const checkpointPattern = /<!--\s*risubard-story-arc-checkpoint:\s*([A-Za-z0-9._:-]{1,200})\s*-->/gu
const wikiLinkPattern = /\[\[([^\]#|]+)(?:#[^|\]]*)?(?:\|([^\]]+))?\]\]/gu

export interface StoryArcLink {
    target: string
    label: string
}

export interface StoryArcView {
    document: WikiDocument | undefined
    checkpointSize: number
    pendingEventCount: number
    remainingEventCount: number
}

function normalizedTitle(value: string): string {
    return value.normalize('NFKC').toLocaleLowerCase().trim()
}

export function findStoryArcDocument(
    documents: readonly WikiDocument[]
): WikiDocument | undefined {
    return documents.find((document) =>
        document.type === 'other'
        && document.status !== 'retracted'
        && isStoryArcTitle(document.title))
}

function storyArcCheckpoint(content: string): string | undefined {
    const matches = [...content.matchAll(checkpointPattern)]
    return matches.at(-1)?.[1]
}

function activeEvents(documents: readonly WikiDocument[], messages?: readonly EventOrderMessage[]): WikiDocument[] {
    const order = createEventOrder(messages)
    return documents
        .filter((document) =>
            document.type === 'event' && document.status === 'active')
        .filter(document => messages === undefined || order.position(document) !== undefined)
        .sort((left, right) => order.compare(left, right))
}

export function buildStoryArcView(
    documents: readonly WikiDocument[],
    requestedCheckpointSize: number,
    messages?: readonly EventOrderMessage[]
): StoryArcView {
    const checkpointSize = Math.max(1, Math.round(requestedCheckpointSize))
    const document = findStoryArcDocument(documents)
    const events = activeEvents(documents, messages)
    const checkpoint = document ? storyArcCheckpoint(document.content) : undefined
    const checkpointIndex = checkpoint
        ? events.findIndex((event) => event.id === checkpoint)
        : -1
    const inheritedCheckpoint = messages !== undefined && documents.some(event =>
        event.id === checkpoint && event.type === 'event' && event.status === 'active'
        && hasOnlyInheritedSources(event))
    const pendingEventCount = document
        ? checkpointIndex >= 0 ? events.length - checkpointIndex - 1
            : inheritedCheckpoint ? events.length : 0
        : events.length

    return {
        document,
        checkpointSize,
        pendingEventCount,
        remainingEventCount: Math.max(0, checkpointSize - pendingEventCount),
    }
}

export function extractStoryArcLinks(markdown: string): StoryArcLink[] {
    const seen = new Set<string>()
    const links: StoryArcLink[] = []
    for (const match of markdown.matchAll(wikiLinkPattern)) {
        const target = match[1].trim()
        const label = (match[2] ?? target).trim()
        const key = normalizedTitle(target)
        if (!target || seen.has(key)) continue
        seen.add(key)
        links.push({ target, label: label || target })
    }
    return links
}

export function storyArcDisplayMarkdown(markdown: string): string {
    return markdown
        .replace(checkpointPattern, '')
        .replace(wikiLinkPattern, (_match, target: string, label?: string) =>
            (label ?? target).trim())
        .trim()
}
