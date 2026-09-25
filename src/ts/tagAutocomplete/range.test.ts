import { describe, expect, test } from 'vitest'
import { tagRange } from './range'

describe('tag replacement boundaries', () => {
    test('left mode preserves right text, separators and surrounding whitespace', () => {
        expect(tagRange('first,  blue hair  , last', 12, 12, 'left')).toEqual({ start: 8, end: 12, query: 'blue' })
        expect(tagRange('first,  blue hair  , last', 12, 12, 'whole')).toEqual({ start: 8, end: 17, query: 'blue hair' })
    })
    test.each([
        ['{{blue hair}}', 11, 2, 11, 'blue hair'],
        ['[blue hair]', 10, 1, 10, 'blue hair'],
        ['(blue hair:1.2)', 10, 1, 10, 'blue hair'],
        ['1.5::blue hair::', 14, 5, 14, 'blue hair'],
        ['-1:: blue hair ::', 14, 5, 14, 'blue hair'],
        ['first\nblue hair, last', 15, 6, 15, 'blue hair'],
        ['blue (hair)', 11, 0, 11, 'blue (hair)'],
    ])('preserves weight syntax in %s', (text, cursor, start, end, query) => {
        expect(tagRange(text, cursor as number, cursor as number, 'whole')).toEqual({ start, end, query })
    })
    test('ignores blank segments, noncollapsed selection and macro syntax', () => {
        expect(tagRange(' , ', 2, 2, 'left')).toBeNull()
        expect(tagRange('blue', 1, 3, 'left')).toBeNull()
        expect(tagRange('{{getvar::hair}}', 12, 12, 'left')).toBeNull()
        expect(tagRange('<piece', 6, 6, 'left')).toBeNull()
    })
    test('supports incomplete wrappers and Unicode query length separately from syntax', () => {
        expect(tagRange(' {파란 머리', 7, 7, 'left')).toEqual({ start: 2, end: 7, query: '파란 머리' })
        expect(tagRange('(blue hair:1.2)', 14, 14, 'left')?.query).toBe('blue hair')
    })
    test.each(['{blue eyes, red hair}', '(blue eyes, red hair:1.2)', '1.2::blue eyes, red hair::', '{{blue eyes, [red hair]}}'])('preserves group weights across delimiters: %s', text => {
        const start = text.indexOf('red hair')
        expect(tagRange(text, start + 3, start + 3, 'whole')).toEqual({ start, end: start + 8, query: 'red hair' })
    })
    test.each(['{{char}}', '{{user}}', '{{char', '{{user'])('leaves bare and unfinished macros to their editor: %s', text => {
        expect(tagRange(text, text.length, text.length, 'whole')).toBeNull()
    })
    test('keeps literal tag parentheses inside an unfinished outer weight group', () => {
        const text = '(first, blue (hair), last)'
        expect(tagRange(text, 12, 12, 'whole')).toEqual({ start: 8, end: 19, query: 'blue (hair)' })
    })
})
