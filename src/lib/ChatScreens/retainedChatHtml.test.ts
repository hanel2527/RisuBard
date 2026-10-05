import { describe, expect, test } from 'vitest'
import { retainedChatHtml } from './retainedChatHtml'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const render = (html: string) => ({ content: Promise.resolve(html), format: (value: string) => value, onRender: () => {} })

describe('retainedChatHtml', () => {
    test('keeps comparison copies out of the live document and patches in place', async () => {
        const node = document.createElement('span')
        const audio = '<audio autoplay loop><source src="a.mp3"></audio>'
        const action = retainedChatHtml(node, render(audio))
        await flush()
        const live = node.querySelector('audio')
        action.update(render(audio + '<p>x</p>'))
        await flush()

        expect(node.querySelectorAll('audio')).toHaveLength(1)
        expect(node.querySelector('audio')).toBe(live)
        expect(live!.ownerDocument).toBe(document)
        expect(node.querySelector('p')?.textContent).toBe('x')
    })

    test('parses comparison HTML outside the live document', async () => {
        const parsed: Element[] = []
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!
        Object.defineProperty(Element.prototype, 'innerHTML', {
            ...descriptor,
            set(value: string) {
                descriptor.set!.call(this, value)
                parsed.push(this)
            },
        })
        try {
            retainedChatHtml(document.createElement('span'), render('<audio autoplay></audio>'))
            await flush()
        } finally {
            Object.defineProperty(Element.prototype, 'innerHTML', descriptor)
        }
        expect(parsed).toHaveLength(1)
        expect(parsed[0].ownerDocument).not.toBe(document)
        expect(parsed[0].querySelector('audio')).not.toBeNull()
    })

    test('keeps <div> parsing rules for stray table cells', async () => {
        const node = document.createElement('span')
        retainedChatHtml(node, render('<td>cell</td>'))
        await flush()
        expect(node.querySelector('td')).toBeNull()
        expect(node.textContent).toBe('cell')
    })
})
