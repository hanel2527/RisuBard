import { describe, expect, test } from 'vitest'
import {
    resolveMemoryRetrievalMetadata,
    type SemanticTemporalHint,
} from './risubard-memory-metadata'

describe('memory retrieval metadata', () => {
    test('normalizes bounded keywords and establishes day zero only for the first event', () => {
        const metadata = resolveMemoryRetrievalMetadata({
            keywords: ['  Gilbert ', 'dance', 'Gilbert', ...Array.from(
                { length: 22 }, (_, index) => `keyword-${index}`
            )],
            priorTimeline: [],
        })

        expect(metadata.keywords).toEqual([
            'Gilbert', 'dance', ...Array.from(
                { length: 22 }, (_, index) => `keyword-${index}`
            ),
        ])
        expect(metadata.storyTime).toEqual({
            day: 0, evidence: 'first recorded event', precision: 'origin',
        })
    })

    test('advances an explicit prior day with grounded elapsed time', () => {
        const temporalHint: SemanticTemporalHint = {
            elapsedDays: 7,
            evidence: 'a week later',
        }
        expect(resolveMemoryRetrievalMetadata({
            keywords: ['dance'],
            priorTimeline: [{ day: 3, precision: 'explicit' }],
            temporalHint,
        }).storyTime).toEqual({
            day: 10, evidence: 'a week later', precision: 'explicit',
        })
    })

    test('does not invent time after an event without grounded elapsed evidence', () => {
        expect(resolveMemoryRetrievalMetadata({
            keywords: ['dance'],
            priorTimeline: [{ day: 3, precision: 'explicit' }],
            temporalHint: { elapsedDays: null, evidence: '' },
        }).storyTime).toEqual({
            day: null,
            evidence: 'no grounded elapsed time',
            precision: 'unknown',
        })
    })

    test('preserves a grounded continuity marker at the same day', () => {
        expect(resolveMemoryRetrievalMetadata({
            keywords: ['dance'],
            priorTimeline: [{ day: 3, precision: 'explicit' }],
            temporalHint: { elapsedDays: 0, evidence: 'that afternoon' },
        }).storyTime).toEqual({
            day: 3, evidence: 'that afternoon', precision: 'explicit',
        })
    })

    test('does not bridge an unknown prior event to an earlier dated event', () => {
        expect(resolveMemoryRetrievalMetadata({
            keywords: ['dance'],
            priorTimeline: [
                { day: 0, precision: 'origin' },
                { day: null, precision: 'unknown' },
            ],
            temporalHint: { elapsedDays: 1, evidence: 'the next day' },
        }).storyTime).toEqual({
            day: null,
            evidence: 'no grounded prior story time',
            precision: 'unknown',
        })
    })
})
