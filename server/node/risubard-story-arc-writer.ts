import {
    isStoryArcTitle,
    wikiWritingLocales,
    type WikiWritingLanguage,
} from '../../src/ts/risubard/wikiWritingLanguage'
import { createEventOrder, hasOnlyInheritedSources, type EventOrderMessage } from '../../src/ts/risubard/eventOrder'
import {
    ARC_PLOTTER_DEFAULT_SETTINGS,
    normalizeArcPlotterSettings,
    type ArcPlotterSettings,
} from '../../src/ts/risubard/arcPlotterSettings'

export const STORY_ARC_CHECKPOINT_SIZE =
    ARC_PLOTTER_DEFAULT_SETTINGS.checkpointSize
export const STORY_ARC_MAX_MARKDOWN_CHARACTERS =
    ARC_PLOTTER_DEFAULT_SETTINGS.maxCharacters
export const STORY_ARC_EVENT_EXCERPT_CHARACTERS = 800

const checkpointPattern = /<!--\s*risubard-story-arc-checkpoint:\s*([A-Za-z0-9._:-]{1,200})\s*-->/gu
const wikiLinkPattern = /\[\[([^\]\r\n]{1,240})\]\]/gu

export interface StoryArcWriterDocument {
    id: string
    type: 'event' | 'other' | string
    title: string
    aliases?: readonly string[]
    content: string
    sourceMessageIds: string[]
    created?: string
    status?: 'active' | 'superseded' | 'retracted'
}

export interface StoryArcUpdatePlan {
    candidate: {
        type: 'other'
        title: string
        aliases: string[]
        reason: string
        action: 'create' | 'update'
        targetDocumentId: string | null
        confidence: number
    }
    events: StoryArcWriterDocument[]
    checkpointEventId: string
}

export { isStoryArcTitle }

export function isStoryArcCandidate(candidate: {
    type: string
    title: string
}): boolean {
    return candidate.type === 'other' && isStoryArcTitle(candidate.title)
}

export function readStoryArcCheckpoint(markdown: string): string | undefined {
    const matches = [...markdown.matchAll(checkpointPattern)]
    return matches.at(-1)?.[1]
}

export function stampStoryArcCheckpoint(
    markdown: string,
    eventId: string
): string {
    if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(eventId)) {
        throw new Error('Story arc checkpoint event ID is invalid')
    }
    const body = markdown.replace(checkpointPattern, '').trimEnd()
    return `${body}\n\n<!-- risubard-story-arc-checkpoint: ${eventId} -->`
}

const identityKey = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim()

/** A title containing a link delimiter cannot be written as [[title]]. */
function linkableEventTitle(title: string): boolean {
    return title.length > 0 && title.length <= 240 && !/[\]\r\n]/u.test(title)
}

function hasStoryArcEventLink(
    markdown: string,
    events: readonly StoryArcWriterDocument[]
): boolean {
    const identities = new Set(events.flatMap((event) =>
        [event.title, ...(event.aliases ?? [])].map(identityKey)
    ))
    // Titles may themselves contain "|" or "#": accept the whole target too.
    return [...markdown.matchAll(wikiLinkPattern)].some((match) => [
        match[1],
        match[1].split('|')[0] ?? '',
        match[1].split('|')[0]?.split('#')[0] ?? '',
    ].some((target) => identities.has(identityKey(target))))
}

export function validateStoryArcCheckpointEventLink(
    markdown: string,
    events: readonly StoryArcWriterDocument[]
): void {
    if (!hasStoryArcEventLink(ensureStoryArcEventLink(markdown, events), events)
        && events.some((event) => linkableEventTitle(event.title))) {
        throw new Error(
            'Story arc plot must link at least one event from the current checkpoint'
        )
    }
}

/**
 * The checkpoint must route to at least one of its events. When the model
 * omits that link, the program adds the latest event under turning points
 * instead of rejecting an otherwise valid rewrite.
 */
export function ensureStoryArcEventLink(
    markdown: string,
    events: readonly StoryArcWriterDocument[]
): string {
    if (hasStoryArcEventLink(markdown, events)) return markdown
    const event = [...events].reverse().find((candidate) => linkableEventTitle(candidate.title))
    if (!event) return markdown
    const bullet = `- [[${event.title}]]`
    const turningPoints = new Set(Object.values(wikiWritingLocales)
        .map((locale) => identityKey(locale.storyArc.turningPoints)))
    const lines = markdown.split('\n')
    const start = lines.findIndex((line) => {
        const heading = line.match(/^#{3,6}[\t ]+(.+?)[\t ]*$/u)
        return heading !== null && turningPoints.has(identityKey(heading[1]))
    })
    if (start < 0) return `${markdown.trimEnd()}\n\n${bullet}\n`
    let end = start + 1
    while (end < lines.length && !/^#{1,6}[\t ]/u.test(lines[end])) end += 1
    while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
    lines.splice(end, 0, bullet)
    return lines.join('\n')
}

export function buildStoryArcUpdatePlan(input: {
    documents: readonly StoryArcWriterDocument[]
    savedEvents: readonly StoryArcWriterDocument[]
    writingLanguage: WikiWritingLanguage
    settings?: Partial<ArcPlotterSettings>
    sourceMessageOrder?: readonly EventOrderMessage[]
}): StoryArcUpdatePlan | undefined {
    const sourceOrder = createEventOrder(input.sourceMessageOrder)
    const settings = normalizeArcPlotterSettings(input.settings)
    const existing = input.documents.find((document) =>
        document.type === 'other'
        && document.status !== 'retracted'
        && isStoryArcTitle(document.title)
    )
    const ordered = [...input.documents, ...input.savedEvents]
        .filter((document) => document.type === 'event'
            && document.status !== 'retracted'
            && document.status !== 'superseded')
        .filter((document, index, all) =>
            all.findIndex((candidate) => candidate.id === document.id) === index)
        .filter(document => input.sourceMessageOrder === undefined
            || sourceOrder.position(document) !== undefined)
        .map((document, index) => ({ document, index }))
        .sort((left, right) => {
            if (input.sourceMessageOrder !== undefined) {
                return sourceOrder.compare(left.document, right.document)
            }
            const byCreated = (left.document.created ?? '')
                .localeCompare(right.document.created ?? '')
            return byCreated || left.index - right.index
        })
        .map(({ document }) => document)
    const checkpoint = existing
        ? readStoryArcCheckpoint(existing.content)
        : undefined
    if (existing && !checkpoint) return undefined
    const checkpointIndex = checkpoint
        ? ordered.findIndex((document) => document.id === checkpoint)
        : -1
    // A fork keeps its predecessor's checkpoint ID but detaches its sources.
    // That checkpoint is before all current-chat events, not a deleted local turn.
    const inheritedCheckpoint = input.sourceMessageOrder !== undefined
        && input.documents.some(document => document.id === checkpoint
            && document.type === 'event'
            && document.status !== 'retracted' && document.status !== 'superseded'
            && hasOnlyInheritedSources(document))
    if (checkpoint && checkpointIndex < 0 && !inheritedCheckpoint) return undefined
    const pending = ordered.slice(checkpointIndex + 1)
    const repairEvents = existing && checkpoint
        && checkpointIndex >= 0
        && !hasStoryArcEventLink(existing.content, ordered)
        ? ordered.slice(
            Math.max(0, checkpointIndex - settings.checkpointSize + 1),
            checkpointIndex + 1
        )
        : undefined
    if (!repairEvents && pending.length < settings.checkpointSize) {
        return undefined
    }

    const events = repairEvents ?? pending.slice(0, settings.checkpointSize)
    const title = existing?.title ?? wikiWritingLocales[input.writingLanguage].storyArc.title
    const eventTitles = events.map((event) => `[[${event.title}]]`).join(', ')
    const reason = repairEvents
        ? `Repair missing event routes in the current story arc checkpoint: ${eventTitles}`
        : `Compact the next confirmed event checkpoint into the routing plot: ${eventTitles}`
    return {
        candidate: {
            type: 'other',
            title,
            aliases: [],
            reason: reason.slice(0, 500),
            action: existing ? 'update' : 'create',
            targetDocumentId: existing?.id ?? null,
            confidence: 1,
        },
        events,
        checkpointEventId: repairEvents ? checkpoint! : events.at(-1)!.id,
    }
}

export function storyArcRewriteInstruction(
    writingLanguage: WikiWritingLanguage,
    value?: Partial<ArcPlotterSettings>
): string {
    const settings = normalizeArcPlotterSettings(value)
    const maxCharacters = settings.maxCharacters.toLocaleString('en-US')
    const arc = wikiWritingLocales[writingLanguage].storyArc
    return [
        `For the reserved other document titled ${arc.title}, use storyArcEvents as the evidence batch.`,
        `It is a compact routing plot, not primary evidence. Keep exactly the useful H3 sections ${arc.overview}, ${arc.turningPoints}, and ${arc.openThreads}.`,
        `Keep at most ${settings.maxArcs} chronological arc bullets, ${settings.maxTurningPoints} turning-point bullets, and ${settings.maxOpenThreads} open-thread bullets. Link representative events as [[event title]].`,
        'Every rewrite must link at least one event from the current storyArcEvents checkpoint.',
        'Merge older adjacent arcs when over the cap while preserving distinctive names, objects, places, causal transitions, and representative event links.',
        `Keep the complete document within ${maxCharacters} characters. Never reproduce full event summaries or character state histories.`,
    ].join('\n')
}
