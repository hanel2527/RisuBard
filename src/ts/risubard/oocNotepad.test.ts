import { describe, expect, test } from 'vitest'
import { buildOocGroups } from './oocTurns'

describe('OOC groups', () => {
    test('groups consecutive assistant turns and preserves original source indices', () => {
        const marked = new Set([4, 5, 8, 10, 11, 12])
        const messages = Array.from({ length: 12 }, (_, i) => [
            { role: 'user', data: `Request ${i + 1}`, chatId: `u${i + 1}` },
            { role: 'char', data: `${marked.has(i + 1) ? '<!-- OOC_turn -->' : ''} Answer ${i + 1}`, chatId: `a${i + 1}` },
        ]).flat()
        const snapshot = structuredClone(messages)
        const groups = buildOocGroups(messages)
        expect(groups.map(group => group.label)).toEqual(['4–5', '8', '10–12'])
        expect(groups.map(group => group.entries.map(entry => entry.index))).toEqual([
            [6, 7, 8, 9], [14, 15], [18, 19, 20, 21, 22, 23],
        ])
        expect(messages).toEqual(snapshot)
        messages[9].data = 'Story swipe'
        expect(buildOocGroups(messages).map(group => group.label)).toEqual(['4', '8', '10–12'])
    })

    test('keeps disabled notes and assistant continuations without duplicating the paired input', () => {
        const groups = buildOocGroups([
            { role: 'user', data: 'Plan' },
            { role: 'char', data: '<!-- OOC_turn --> One' },
            { role: 'char', data: '<!-- OOC_turn --> Two' },
            { role: 'char', disabled: true, data: '<!-- OOC_turn --> Archived' },
            { role: 'char', isComment: true, data: '<!-- OOC_turn --> Comment' },
        ])
        expect(groups).toHaveLength(1)
        expect(groups[0].label).toBe('1–2')
        expect(groups[0].entries.map(entry => entry.index)).toEqual([0, 1, 2, 3])
    })
})
