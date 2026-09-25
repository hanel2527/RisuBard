import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPainterParagraphStops, nearestPainterParagraphStop } from './placement'

function rect(top: number, bottom: number, left = 20, width = 400): DOMRect {
    return { x: left, y: top, top, bottom, left, right: left + width, width, height: bottom - top, toJSON: () => ({}) }
}

function message(html: string, selectors: string[]) {
    const root = document.createElement('div')
    root.dataset.painterMessage = 'message'
    root.innerHTML = html
    root.getBoundingClientRect = () => rect(0, Math.max(20, selectors.length * 40 - 20))
    document.body.append(root)
    selectors.forEach((selector, index) => {
        root.querySelector<HTMLElement>(selector)!.getBoundingClientRect = () => rect(index * 40, index * 40 + 20)
    })
    return root
}

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

describe('BardPainter paragraph placement', () => {
    it('snaps between paragraphs and retains the next paragraph Markdown prefix', () => {
        const source = 'First paragraph.\n\n## A heading\n\nLast paragraph.'
        const root = message('<p>First paragraph.</p><h2>A heading</h2><p>Last paragraph.</p>', ['p:first-child', 'h2', 'p:last-child'])
        const stops = getPainterParagraphStops(root, source)
        expect(stops.map(stop => stop.offset)).toEqual([0, source.indexOf('##'), source.indexOf('Last'), source.length])
        expect(stops.map(stop => stop.top)).toEqual([0, 30, 70, 100])
        expect(nearestPainterParagraphStop(stops, 37)).toBe(stops[1])
        expect(stops[1]).toMatchObject({ left: 20, width: 400 })
    })

    it('uses full prefix offsets for duplicate text and substituted names', () => {
        const source = '{{user}} waits.\n\n## {{char}}\n\n{{user}} waits.'
        const root = message('<p>John waits.</p><h2>Mira</h2><p>John waits.</p>', ['p:first-child', 'h2', 'p:last-child'])
        expect(getPainterParagraphStops(root, source, { user: 'John', char: 'Mira' }).map(stop => stop.offset))
            .toEqual([0, source.indexOf('##'), source.lastIndexOf('{{user}}'), source.length])
    })

    it('unwraps structural wrappers and respects the message body boundary', () => {
        const source = 'One **bold** word.\n\nAnother paragraph.'
        const root = message('<header>Generated label</header><div data-painter-body><div><span><p>One <strong>bold</strong> word.</p></span></div><div><p>Another <em>paragraph.</em></p></div></div><footer>Generated footer</footer>', ['p:first-of-type', 'div[data-painter-body] > div:last-child p'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, source.indexOf('Another'), source.length])
    })

    it('keeps lists, code fences, blockquotes and tables atomic', () => {
        const source = 'Intro\n\n- First item\n- Second item\n\n```text\nline one\n\nline two\n```\n\n> Quoted\n>\n> paragraph\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nEnd'
        const root = message('<p>Intro</p><ul><li><p>First item</p></li><li><p>Second item</p></li></ul><pre><code>line one\n\nline two\n</code></pre><blockquote><p>Quoted</p><p>paragraph</p></blockquote><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><p>End</p>', ['p:first-child', 'ul', 'pre', 'blockquote', 'table', ':scope > p:last-child'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([
            0, source.indexOf('- First'), source.indexOf('```'), source.indexOf('> Quoted'), source.indexOf('| A'), source.indexOf('End'), source.length,
        ])
    })

    it('maps rewritten paragraphs by order only when block counts are equal', () => {
        const source = '{{sceneA}}\n\n{{sceneB}}\n\n{{sceneC}}'
        const root = message('<p>A rendered scene.</p><p>A changed scene.</p><p>The final scene.</p>', ['p:nth-child(1)', 'p:nth-child(2)', 'p:nth-child(3)'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, source.indexOf('{{sceneB}}'), source.indexOf('{{sceneC}}'), source.length])
    })

    it('keeps an unmatched generated introduction separate from subsequent matched paragraphs', () => {
        const source = 'Original scene.\n\nAnother original scene.'
        const root = message('<p>Generated introduction.</p><p>Original scene.</p><p>Another original scene.</p>', ['p:nth-child(1)', 'p:nth-child(2)', 'p:nth-child(3)'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, null, source.indexOf('Another'), source.length])
    })

    it('can still place between unchanged paragraphs before a generated footer', () => {
        const source = 'One.\n\nTwo.\n{{footer}}'
        const root = message('<p>One.</p><p>Two.</p><p>Generated footer.</p>', ['p:nth-child(1)', 'p:nth-child(2)', 'p:nth-child(3)'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, source.indexOf('Two.'), null, source.length])
    })

    it('ignores source and displayed styles, scripts and comments before matching paragraphs', () => {
        const source = '<style>.sample { color: red; }</style>\n\n<script>const ignored = 1;</script>\n\n<!-- metadata -->\n\nFirst paragraph.\n\nSecond paragraph.\n\nLast paragraph.'
        const root = message('<style>.sample { color: red; }</style><script>const ignored = 1;</script><!-- metadata --><p>First paragraph.</p><p>Second paragraph.</p><p>Last paragraph.</p>', ['p:nth-of-type(1)', 'p:nth-of-type(2)', 'p:nth-of-type(3)'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, source.indexOf('Second'), source.indexOf('Last'), source.length])
    })

    it('finds safe paragraph tag boundaries inside a raw HTML container', () => {
        const source = '<div class="story"><p>First <strong>paragraph.</strong></p><p>Second paragraph.</p><p>Last paragraph.</p></div>'
        const root = message(source, ['p:nth-child(1)', 'p:nth-child(2)', 'p:nth-child(3)'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, source.indexOf('<p>Second'), source.indexOf('<p>Last'), source.length])
    })

    it('keeps nested lists and code atomic inside HTML containers with quoted attributes', () => {
        const source = '<div data-note="a > b"><p>Before.</p><ul><li><p>One.</p></li><li><p>Two.</p></li></ul><pre><code>line one\n\nline two</code></pre><p>After.</p></div>'
        const root = message(source, ['div > p:first-child', 'ul', 'pre', 'div > p:last-child'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, source.indexOf('<ul>'), source.indexOf('<pre>'), source.indexOf('<p>After'), source.length])
    })

    it('matches unchanged paragraph order across nested HTML wrapper boundaries', () => {
        const source = '<section><div><p>One.</p></div><div><p>Two.</p></div></section>\n\nThree.'
        const root = message('<section><div><p>One.</p></div><div><p>Two.</p></div></section><p>Three.</p>', ['section > div:first-child p', 'section > div:last-child p', ':scope > p'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, source.indexOf('<p>Two'), source.indexOf('Three.'), source.length])
    })

    it('retains duplicate paragraph order after ignored source metadata', () => {
        const source = '<style>.sample{color:red}</style>\n\nRepeated.\n\nRepeated.\n\nLast.'
        const root = message('<p>Repeated.</p><p>Repeated.</p><p>Last.</p>', ['p:nth-child(1)', 'p:nth-child(2)', 'p:nth-child(3)'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, source.lastIndexOf('Repeated.'), source.indexOf('Last.'), source.length])
    })

    it('keeps uncertain local gaps instead of snapping a click to a distant message end', () => {
        const source = 'Start.\n\nOriginal middle.\n\nEnd.'
        const root = message('<p>Start.</p><p>Generated middle one.</p><p>Generated middle two.</p><p>End.</p>', ['p:nth-child(1)', 'p:nth-child(2)', 'p:nth-child(3)', 'p:nth-child(4)'])
        const stops = getPainterParagraphStops(root, source)
        expect(stops.map(stop => stop.offset)).toEqual([0, null, null, null, source.length])
        expect(nearestPainterParagraphStop(stops, 70)).toMatchObject({ offset: null, top: 70 })
    })

    it('does not reorder exact text matches or guess which duplicate was generated', () => {
        const source = 'Start.\n\nAlpha.\n\nBeta.\n\nEnd.'
        const root = message('<p>Start.</p><p>Beta.</p><p>Alpha.</p><p>End.</p>', ['p:nth-child(1)', 'p:nth-child(2)', 'p:nth-child(3)', 'p:nth-child(4)'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, null, null, null, source.length])
        const duplicates = message('<p>Start.</p><p>Repeated.</p><p>Repeated.</p><p>End.</p>', ['p:nth-child(1)', 'p:nth-child(2)', 'p:nth-child(3)', 'p:nth-child(4)'])
        const duplicateSource = 'Start.\n\nRepeated.\n\nEnd.'
        expect(getPainterParagraphStops(duplicates, duplicateSource).map(stop => stop.offset)).toEqual([0, null, null, null, duplicateSource.length])
    })

    it('uses ordinal correspondence for rewritten blocks bounded by unchanged paragraphs', () => {
        const source = 'Start.\n\n{{scene}}\n\nEnd.'
        const root = message('<p>Generated header.</p><p>Start.</p><p>The expanded scene.</p><p>End.</p>', ['p:nth-child(1)', 'p:nth-child(2)', 'p:nth-child(3)', 'p:nth-child(4)'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, null, source.indexOf('{{scene}}'), source.indexOf('End.'), source.length])
    })

    it('finds safe paragraph breaks in inline text rendered with br elements', () => {
        const source = 'One bold word.\n\nAnother paragraph.'
        const root = message('<span>One <strong>bold</strong> word.</span><br><br><span>Another paragraph.</span>', [])
        vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
            return this.toString().startsWith('Another') ? rect(40, 60) : rect(0, 20)
        })
        expect(getPainterParagraphStops(root, source).map(stop => [stop.offset, stop.top])).toEqual([[0, 0], [source.indexOf('Another'), 30], [source.length, 60]])
    })

    it('uses a Range rectangle for display contents and text-only paragraphs', () => {
        const source = 'First.\n\nSecond.'
        const root = message(source, [])
        root.getBoundingClientRect = () => rect(0, 0, 0, 0)
        vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
            return this.toString().trim().startsWith('Second') ? rect(80, 100) : rect(20, 40)
        })
        expect(getPainterParagraphStops(root, source).map(stop => [stop.offset, stop.top])).toEqual([[0, 20], [source.indexOf('Second'), 60], [source.length, 100]])
    })

    it('does not split a single paragraph at its visual line break', () => {
        const source = 'One line\ncontinued line.'
        const root = message('<p>One line<br>continued line.</p>', ['p'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, source.length])
    })

    it('preserves original Windows newline offsets', () => {
        const source = 'First.\r\n\r\n## Second.\r\n\r\nThird.'
        const root = message('<p>First.</p><h2>Second.</h2><p>Third.</p>', ['p:first-child', 'h2', 'p:last-child'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, source.indexOf('##'), source.indexOf('Third'), source.length])
    })

    it('uses text geometry when paragraph wrappers use display contents', () => {
        const source = 'First.\n\nSecond.'
        const root = message('<p style="display:contents">First.</p><p style="display:contents">Second.</p>', [])
        vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
            return this.toString() === 'Second.' ? rect(80, 100) : rect(20, 40)
        })
        expect(getPainterParagraphStops(root, source).map(stop => [stop.offset, stop.top])).toEqual([[0, 20], [source.indexOf('Second'), 60], [source.length, 100]])
    })

    it('handles images and horizontal rules as atomic paragraphs', () => {
        const source = 'Start\n\n![scene](image.webp)\n\n---\n\nEnd'
        const root = message('<p>Start</p><p><img src="image.webp" alt="scene"></p><hr><p>End</p>', ['p:first-child', 'p:nth-child(2)', 'hr', 'p:last-child'])
        expect(getPainterParagraphStops(root, source).map(stop => stop.offset)).toEqual([0, source.indexOf('!['), source.indexOf('---'), source.indexOf('End'), source.length])
    })

    it('returns no nearest stop for empty or non-finite input', () => {
        expect(nearestPainterParagraphStop([], 20)).toBeUndefined()
        expect(nearestPainterParagraphStop([{ offset: 0, top: 0, left: 0, width: 200 }], NaN)).toBeUndefined()
    })
})
