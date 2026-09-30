import { describe, expect, it } from 'vitest'
import type { NarrativeMemoryWikiMarkdown } from './memoryWiki'
import {
    buildStoryArcView,
    extractStoryArcLinks,
    findStoryArcDocument,
    storyArcDisplayMarkdown,
} from './storyArcView'
import { wikiWritingLocales } from './wikiWritingLanguage'

type WikiDocument = NarrativeMemoryWikiMarkdown['documents'][number]

function document(
    id: string,
    type: WikiDocument['type'],
    title: string,
    content = `# ${title}`,
    created = '2026-08-31T00:00:00.000Z'
): WikiDocument {
    return {
        id,
        type,
        title,
        content,
        created,
        updated: created,
        relativePath: `${type === 'event' ? 'events' : 'notes'}/${id}.md`,
        status: 'active',
        aliases: [],
        sourceMessageIds: [],
        links: [],
        contextMode: 'auto',
        contentHash: `hash-${id}`,
    }
}

describe('story arc view model', () => {
    it('counts new chat events after an inherited checkpoint', () => {
        const inherited = { ...document('event.old', 'event', 'Old'), sourceMessageIds: ['inherited:parent:a1'] }
        const current = { ...document('event.new', 'event', 'New'), sourceMessageIds: ['a1'] }
        const plot = document('other.arc', 'other', 'Story Arc Map',
            '## Story Arc Map\n\n<!-- risubard-story-arc-checkpoint: event.old -->')
        expect(buildStoryArcView([inherited, current, plot], 8, [{ chatId: 'a1', role: 'char' }]))
            .toMatchObject({ pendingEventCount: 1, remainingEventCount: 7 })
        expect(buildStoryArcView([{ ...inherited, sourceMessageIds: ['deleted'] }, current, plot], 8,
            [{ chatId: 'a1', role: 'char' }])).toMatchObject({ pendingEventCount: 0 })
    })

    it('does not count a repaired earlier turn or an unresolved source after the checkpoint', () => {
        const events = [1, 2, 3].map(index => ({
            ...document(`event.${index}`, 'event', `Event ${index}`, '',
                index === 1 ? '2026-09-30' : `2026-01-0${index}`),
            sourceMessageIds: [`a${index}`],
        }))
        const plot = document('other.arc', 'other', 'Story Arc Map',
            '## Story Arc Map\n\n<!-- risubard-story-arc-checkpoint: event.2 -->')
        const messages = [1, 2, 3].map(index => ({ chatId: `a${index}`, role: 'char' }))
        expect(buildStoryArcView([...events, plot,
            document('event.unknown', 'event', 'Deleted source')], 8, messages))
            .toMatchObject({ pendingEventCount: 1, remainingEventCount: 7 })
    })

    it('reports confirmed-event progress before the first plot is created', () => {
        const documents = [
            document('event.1', 'event', '출발'),
            document('event.2', 'event', '첫 관문'),
            document('event.3', 'event', '숲의 밤'),
        ]

        expect(buildStoryArcView(documents, 8)).toMatchObject({
            document: undefined,
            pendingEventCount: 3,
            remainingEventCount: 5,
            checkpointSize: 8,
        })
    })

    it('counts only active events after the stored checkpoint', () => {
        const plot = document(
            'other.arc',
            'other',
            '스토리 아크 플롯',
            '# 스토리 아크 플롯\n\n[[출발]]\n\n<!-- risubard-story-arc-checkpoint: event.2 -->'
        )
        const documents = [
            document('event.1', 'event', '출발', '# 출발', '2026-08-01T00:00:00.000Z'),
            document('event.2', 'event', '첫 관문', '# 첫 관문', '2026-08-02T00:00:00.000Z'),
            { ...document('event.old', 'event', '철회', '# 철회'), status: 'retracted' as const },
            document('event.3', 'event', '숲의 밤', '# 숲의 밤', '2026-08-03T00:00:00.000Z'),
            plot,
        ]

        expect(buildStoryArcView(documents, 8)).toMatchObject({
            document: plot,
            pendingEventCount: 1,
            remainingEventCount: 7,
        })
    })

    it('recognizes current and legacy reserved plot titles', () => {
        const legacy = document('other.legacy', 'other', '스토리 아크 지도')
        expect(findStoryArcDocument([legacy])).toBe(legacy)
        expect(findStoryArcDocument([
            document('other.en', 'other', 'Story Arc Plot'),
        ])?.title).toBe('Story Arc Plot')
    })

    it.each(Object.entries(wikiWritingLocales))(
        'finds the %s plot the wiki writer creates', (locale, definition) => {
            const plot = document('other.plot', 'other', definition.storyArc.title)
            expect(findStoryArcDocument([plot])).toBe(plot)
            expect(findStoryArcDocument([
                document('other.other', 'other', 'Unrelated note'),
                plot,
            ])).toBe(plot)
        }
    )

    it('extracts unique wiki links and removes wiki markup for display', () => {
        const markdown = '[[출발]] · [[귀환|마지막 귀환]] · [[출발]]'
        expect(extractStoryArcLinks(markdown)).toEqual([
            { target: '출발', label: '출발' },
            { target: '귀환', label: '마지막 귀환' },
        ])
        expect(storyArcDisplayMarkdown(markdown))
            .toBe('출발 · 마지막 귀환 · 출발')
    })
})
