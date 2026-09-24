import { describe, expect, test } from 'vitest'
import { repairRebootEventLinks } from './risubard-reboot-event-links'

const events = [
    { id: 'event.a', title: 'Arrival', aliases: [] },
    { id: 'event.b', title: 'Departure', aliases: [] },
]
const combined = 'Arrival \u00b7 Departure'

describe('reboot event links', () => {
    test('repairs only the exact synthetic batch title and preserves surrounding text', () => {
        expect(repairRebootEventLinks(`12:00: [[${combined}]] - Summary. [[Other]]`, combined, events, events))
            .toBe('12:00: [[Arrival]], [[Departure]] - Summary. [[Other]]')
    })

    test('preserves a real title or alias that owns the combined name', () => {
        for (const owner of [
            { id: 'real', title: combined, aliases: [] },
            { id: 'real', title: 'Real', aliases: [combined] },
        ]) {
            expect(repairRebootEventLinks(`[[${combined}]]`, combined, events, [...events, owner]))
                .toBe(`[[${combined}]]`)
        }
    })

    test('does not invent links for missing, single or ambiguous events', () => {
        for (const batch of [[], events.slice(0, 1), [events[0], events[0]]]) {
            expect(repairRebootEventLinks(`[[${combined}]]`, combined, batch, events))
                .toBe(`[[${combined}]]`)
        }
        expect(repairRebootEventLinks(`[[${combined}]]`, combined, events,
            [...events, { id: 'duplicate', title: 'Arrival', aliases: [] }]))
            .toBe(`[[${combined}]]`)
    })

    test('uses full individual titles even when the synthetic title was truncated', () => {
        const batch = [events[0], { ...events[1], title: 'B'.repeat(160) }]
        const title = batch.map((event) => event.title).join(' \u00b7 ').slice(0, 160)
        expect(repairRebootEventLinks(`[[${title}]]`, title, batch, batch))
            .toBe(`[[Arrival]], [[${batch[1].title}]]`)
    })

    test('keeps separators inside individual document titles', () => {
        const batch = [{ ...events[0], title: 'A \u00b7 B' }, events[1]]
        const title = batch.map((event) => event.title).join(' \u00b7 ')
        expect(repairRebootEventLinks(`[[${title}]]`, title, batch, batch))
            .toBe('[[A \u00b7 B]], [[Departure]]')
    })
})
