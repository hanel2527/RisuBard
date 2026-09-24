import { describe, expect, it } from 'vitest'
import { mapPainterSelection, insertPainterReference, shiftPainterAnchor, projectPainterText } from './selection'

describe('BardPainter saved selection', () => {
    it('projects only visible text through style markup and invisible metadata', () => {
        const source = '<style>p { color:red }</style><!-- hidden --><script>ignored()</script><p>{{char}} waits.</p>'
        const projection = projectPainterText(source, true, { char: 'Mira' })
        expect(projection.value).toBe('Mirawaits.')
        expect(projection.map[0]).toBe(source.indexOf('{{char}}'))
        expect(projectPainterText('\u2060\u180eMira\u200b waits.\ufeff', false).value).toBe('Mirawaits.')
    })
    it('maps substituted names to their own token, including a partial name selection', () => {
        const source = '{{user}} waves. John listens to {{char}}.'
        const rendered = 'John waves. John listens to Mira.'
        const names = { user: 'John', char: 'Mira' }
        expect(mapPainterSelection(source, rendered, 0, 4, names)).toEqual({ start: 0, end: 8 })
        expect(mapPainterSelection(source, rendered, 1, 3, names)).toEqual({ start: 0, end: 8 })
        const second = rendered.lastIndexOf('John')
        expect(mapPainterSelection(source, rendered, second, second + 4, names)).toEqual({ start: 16, end: 20 })
        const char = rendered.indexOf('Mira')
        const range = mapPainterSelection(source, rendered, char, char + 4, names)!
        expect(source.slice(range.start, range.end)).toBe('{{char}}')
    })
    it('supports legacy name tags and maps later story text after substitutions', () => {
        const source = '<User> meets {{bot}}. The door opens.'
        const rendered = 'John meets Mira. The door opens.'
        const range = mapPainterSelection(source, rendered, rendered.indexOf('The'), rendered.length, { user: 'John', bot: 'Mira' })!
        expect(source.slice(range.start, range.end)).toBe('The door opens.')
    })
    it('does not project name tokens nested inside hidden markup', () => {
        const source = '<!-- {{user}} -->{{char}} waves.'
        const range = mapPainterSelection(source, 'Mira waves.', 0, 4, { user: 'John', char: 'Mira' })!
        expect(source.slice(range.start, range.end)).toBe('{{char}}')
    })
    it('maps story text before a transformed footer without requiring the footer to match', () => {
        const source = '문을 열었다.\n\n바람이 불어왔다.\n{{footer}}'
        const rendered = '문을 열었다.바람이 불어왔다.이번 턴 정보캐릭터 상태'
        const start = rendered.indexOf('바람')
        const range = mapPainterSelection(source, rendered, start, start + 9)!
        expect(source.slice(range.start, range.end)).toBe('바람이 불어왔다.')
    })
    it('keeps later passage offsets when the renderer typesets earlier punctuation', () => {
        const source = '"......잠깐."\n\n문 앞에 섰다.\n{{footer}}'
        const rendered = '“...잠깐.”문 앞에 섰다.이번 턴 정보'
        const start = rendered.indexOf('문 앞')
        const range = mapPainterSelection(source, rendered, start, start + 8)!
        expect(source.slice(range.start, range.end)).toBe('문 앞에 섰다.')
    })
    it('maps the second identical visible passage to its original Markdown position', () => {
        const source = '**문을 열었다.**\n\n다시 **문을 열었다.**'
        const rendered = '문을 열었다.다시 문을 열었다.'
        const start = rendered.lastIndexOf('문을')
        const range = mapPainterSelection(source, rendered, start, rendered.length)!
        expect(source.slice(range.start, range.end)).toBe('**문을 열었다.**')
        expect(range.start).toBe(source.lastIndexOf('**문을'))
    })
    it('preserves emoji and multiline selection boundaries', () => {
        const source = '먼저\n\n그녀가 🌙를 보았다.\n그리고 웃었다.\n\n끝'
        const rendered = '먼저그녀가 🌙를 보았다.그리고 웃었다.끝'
        const range = mapPainterSelection(source, rendered, 2, rendered.length - 1)!
        expect(source.slice(range.start, range.end)).toBe('그녀가 🌙를 보았다.\n그리고 웃었다.')
    })
    it('never guesses a duplicated occurrence when rendered content differs', () => {
        expect(mapPainterSelection('말 말', '번역 말 말', 5, 6)).toBeNull()
    })
    it('never maps a substituted name to a different literal occurrence', () => {
        expect(mapPainterSelection('{{user}} waves. John listens.', 'John waves. John listens.', 0, 4)).toBeNull()
        expect(mapPainterSelection('one actual word', 'generated text plus actual word', 20, 26)).toBeNull()
    })
    it.each([
        ['A &amp; B', 'A & B', 0, 3, { start: 0, end: 7 }],
        ['A &amp; B', 'A & B', 2, 3, { start: 2, end: 7 }],
        ['A &#x1F319; B', 'A 🌙 B', 2, 4, { start: 2, end: 11 }],
    ])('keeps the full source entity in %s', (source, rendered, start, end, expected) => {
        const range = mapPainterSelection(source, rendered, start, end)
        expect(range).toEqual(expected)
        const inserted = insertPainterReference(source, range!, 'image', 'after').text
        expect(inserted).toContain(`${source.slice(expected.start, expected.end)}\n\n{{inlay::image}}`)
    })
    it('wraps a fully selected link so neither insertion boundary splits Markdown', () => {
        const source = '[home](https://example.com)'
        const range = mapPainterSelection(source, 'home', 0, 4)
        expect(range).toEqual({ start: 0, end: 27 })
        expect(insertPainterReference(source, range!, 'image', 'before').text).toBe('\n\n{{inlay::image}}\n\n[home](https://example.com)')
        expect(insertPainterReference(source, range!, 'image', 'after').text).toBe('[home](https://example.com)\n\n{{inlay::image}}\n\n')
    })
    it.each([
        ['**hello world**', 'hello world', 0, 5],
        ['**hello world**', 'hello world', 6, 11],
        ['[hello world](https://example.com)', 'hello world', 0, 5],
        ['a **hello world** z', 'a hello world z', 0, 7],
        ['a **hello world** z', 'a hello world z', 8, 15],
        ['**hello *world* again**', 'hello world again', 6, 11],
    ])('rejects partial formatting instead of inserting inside %s', (source, rendered, start, end) => {
        expect(mapPainterSelection(source, rendered, start, end)).toBeNull()
    })
    it.each([
        ['***hello***', 'hello'],
        ['**hello *world* again**', 'hello world again'],
        ['**hello *world***', 'hello world'],
        ['**[home](https://example.com)**', 'home'],
    ])('keeps nested formatting intact when all of %s is selected', (source, rendered) => {
        expect(mapPainterSelection(source, rendered, 0, rendered.length)).toEqual({ start: 0, end: source.length })
    })
    it('inserts using remembered offsets with no selection or context lookup', () => {
        const source = '앞 장면 뒤'
        expect(insertPainterReference(source, { start: 2, end: 4 }, 'image-id', 'after'))
            .toEqual({ text: '앞 장면\n\n{{inlay::image-id}}\n\n 뒤', position: 4, length: 23 })
    })
    it('rejects unavailable offsets instead of relocating', () => {
        expect(() => insertPainterReference('짧음', { start: 10, end: 12 }, 'id', 'before')).toThrow()
    })
    it('adjusts remembered ranges only for insertions performed by the painter itself', () => {
        expect(shiftPainterAnchor({ start: 4, end: 9 }, 4, 5)).toEqual({ start: 9, end: 14 })
        expect(shiftPainterAnchor({ start: 4, end: 9 }, 9, 5)).toEqual({ start: 4, end: 9 })
    })
})
