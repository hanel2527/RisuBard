import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { observeChatScroll } from './observeChatScroll'
import { captureChatScrollAnchor, restoreChatScrollAnchor } from './chatScrollAnchor'
import { scrollWithinContainer } from './scrollWithin'
import { getChatPageForMessage } from 'src/ts/chatPagination'

// Exercise the actual screen handler without mounting the entire application.
const source = readFileSync('src/lib/ChatScreens/DefaultChatScreen.svelte', 'utf8')
const start = source.indexOf('    async function scrollToMessage(index: number)')
const code = ts.transpileModule(source.slice(start, source.indexOf('\n    async function send()', start)), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

function screen(present = true) {
    vi.useFakeTimers()
    const image = { complete: false, onload: vi.fn(), onerror: vi.fn() }
    const element = { classList: { add: vi.fn(), remove: vi.fn() }, getBoundingClientRect: () => ({ top: 0 }) }
    const query = vi.fn(() => present ? element : null)
    const container = { querySelector: query, querySelectorAll: () => [image], getBoundingClientRect: () => ({ top: 0 }) }
    const context: any = {
        paginationKey: 'chat-a', scrollJumpRequest: 0,
        oocTurnIndices: () => new Set(), currentChat: Array(60),
        DBState: { db: { risuBardHideOocTurns: false, preserveChatScrollPosition: true } },
        chatFoldedState: { data: null },
        isScrollingToMessage: false, chatPage: 1, chatPageSize: 30,
        getChatPageForMessage, tick: async () => {},
        chatScrollContainer: container,
        document: { querySelector: (selector: string) => selector === '.default-chat-screen' ? container : query() },
        scrollWithinContainer: vi.fn(),
        sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
        setTimeout, clearTimeout,
        scrollAnchorObserver: { reset: vi.fn(), markProgrammaticScroll: vi.fn() },
        currentScrollAnchor: null, clearScrollAnchorTimers: vi.fn(),
        captureCurrentScrollAnchor: vi.fn(),
    }
    runInNewContext(code, context)
    return { context, container, element, image, query }
}

describe('message jump latency', () => {
    test.each([0, 28])('keeps page 1 message %i when its scroll event arrives after async body layout', async (targetIndex) => {
        const { context } = screen()
        let resize = () => {}
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: () => void) { resize = callback }
            observe() {} unobserve() {} disconnect() {}
        })
        vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} })
        const container = document.createElement('div')
        container.getBoundingClientRect = () => ({ top: 0, bottom: 500, height: 500 }) as DOMRect
        container.scrollTo = ((options: ScrollToOptions) => { container.scrollTop = Math.min(0, options.top!) }) as typeof container.scrollTo
        let messageHeight = 30
        for (let index = 0; index < 30; index++) {
            const message = document.createElement('div')
            message.dataset.chatIndex = String(index)
            message.getBoundingClientRect = () => {
                const top = (index - 30) * messageHeight + 500 - container.scrollTop
                return { top, bottom: top + messageHeight, height: messageHeight } as DOMRect
            }
            container.append(message)
        }
        context.chatScrollContainer = container
        context.scrollWithinContainer = scrollWithinContainer
        context.scrollAnchorObserver = observeChatScroll(container, () => {
            context.currentScrollAnchor = captureChatScrollAnchor(container, context.paginationKey, 60)
        }, () => {
            if (context.currentScrollAnchor) restoreChatScrollAnchor(container, context.currentScrollAnchor, context.paginationKey, 60)
        })

        // Page 2 -> page 1, first assistant turn. Wrappers exist before markdown resolves.
        await context.scrollToMessage(targetIndex)
        expect(context.chatPage).toBe(0)
        messageHeight = 300
        // The queued programmatic scroll event runs before ResizeObserver.
        container.dispatchEvent(new Event('scroll'))
        resize()

        expect(context.currentScrollAnchor.messageIndex).toBe(targetIndex)
        expect(container.children[targetIndex].getBoundingClientRect().top).toBe(0)
        context.scrollAnchorObserver.destroy()
    })

    test('jumps immediately to an existing target despite unrelated unloaded images', async () => {
        const { context, element, container, image } = screen()
        const onload = image.onload
        const jump = context.scrollToMessage(43)
        await vi.advanceTimersByTimeAsync(0)
        expect(context.scrollWithinContainer).toHaveBeenCalledExactlyOnceWith(element, container, { block: 'start', behavior: 'instant' })
        expect(context.isScrollingToMessage).toBe(false)
        expect(image.onload).toBe(onload)
        expect(context.currentScrollAnchor).toMatchObject({ messageIndex: 43, offsetTop: 0 })
        await jump
    })

    test('waits only for a missing target and clears loading when it mounts', async () => {
        const { context, query, element } = screen(false)
        const jump = context.scrollToMessage(43)
        await vi.advanceTimersByTimeAsync(0)
        expect(context.isScrollingToMessage).toBe(true)
        query.mockReturnValue(element)
        await vi.advanceTimersByTimeAsync(100)
        await jump
        expect(context.scrollWithinContainer).toHaveBeenCalledTimes(1)
        expect(context.isScrollingToMessage).toBe(false)
    })

    test('abandons a pending jump when the chat changes', async () => {
        const { context, query, element } = screen(false)
        const jump = context.scrollToMessage(43)
        await vi.advanceTimersByTimeAsync(0)
        context.paginationKey = 'chat-b'
        query.mockReturnValue(element)
        await vi.advanceTimersByTimeAsync(100)
        expect(context.scrollWithinContainer).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(6000)
        await jump
        expect(context.isScrollingToMessage).toBe(false)
    })
})
