import { describe, expect, test } from 'vitest'
import { lineDiff } from './externalChangeDiff'

const types = (before: string, after: string, context?: number) =>
    lineDiff(before, after, context).map(line => `${line.type}:${line.text}`)

describe('lineDiff', () => {
    test('marks a replaced line between unchanged neighbours', () => {
        expect(types('a\nb\nc', 'a\nB\nc')).toEqual(['same:a', 'del:b', 'add:B', 'same:c'])
    })

    test('handles pure additions and removals', () => {
        expect(types('', 'x')).toEqual(['del:', 'add:x'])
        expect(types('a\nb', 'a')).toEqual(['same:a', 'del:b'])
        expect(types('a', 'a\nb')).toEqual(['same:a', 'add:b'])
    })

    test('collapses long unchanged runs outside the context', () => {
        const before = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n')
        const after = ['1', '2', '3', '4', '5', '6', '7', 'eight'].join('\n')
        expect(types(before, after, 1)).toEqual(['skip:6', 'same:7', 'del:8', 'add:eight'])
    })

    test('keeps the order of interleaved edits', () => {
        expect(types('a\nb\nc\nd', 'a\nx\nc\ny', 5)).toEqual(['same:a', 'del:b', 'add:x', 'same:c', 'del:d', 'add:y'])
    })

    test('returns nothing but context for identical text', () => {
        expect(types('a\nb\nc', 'a\nb\nc')).toEqual(['skip:3'])
    })
})
