import { searchTags } from './client'
import { highlightTagMatch, type TagSuggestion } from './search'
import { matchesTagHotkey, type TagAutocompleteSettings } from './settings'
import { tagRange, type TagRange } from './range'
import { popupPosition, textareaCaret } from './placement'
import './popup.css'

let nextId = 0
const categories: Record<number, string> = { 0: '일반', 1: '작가', 3: '작품', 4: '캐릭터', 5: '메타', 6: '종족', 7: '메타', 8: '로어' }
type Snapshot = { text: string; start: number; end: number }

/** Opt-in action. Its state and lifetime belong only to this textarea. */
export function tagAutocomplete(input: HTMLTextAreaElement, initial: TagAutocompleteSettings) {
    let settings = initial
    let version = 0
    let pending: AbortController | undefined
    let destroyed = false
    let composing = false
    let compositionEndedAt = -Infinity
    let inserting = false
    let dismissed = false
    let popup: HTMLDivElement | undefined
    let items: TagSuggestion[] = []
    let selected = 0
    let range: TagRange | null = null
    let requested: Snapshot | undefined
    const id = `danbooru-tags-${++nextId}`
    const listeners: (() => void)[] = []
    const aria = ['role', 'aria-autocomplete', 'aria-haspopup', 'aria-expanded', 'aria-controls', 'aria-activedescendant']
    const originalAria = aria.map(name => input.getAttribute(name))
    const snapshot = (): Snapshot => ({ text: input.value, start: input.selectionStart, end: input.selectionEnd })
    const unchanged = (value: Snapshot) => input.value === value.text && input.selectionStart === value.start && input.selectionEnd === value.end
    // Native insertText joins the existing browser undo history. Older engines without it use
    // a per-editor history, collected from mount so replacement still undoes in one step.
    let fallbackHistory = false
    let history: Snapshot[] = [snapshot()]
    let historyIndex = 0
    function record() {
        const value = snapshot()
        if (history[historyIndex].text === value.text) { history[historyIndex] = value; return }
        history = history.slice(0, historyIndex + 1)
        history.push(value)
        if (history.length > 200) history.shift()
        historyIndex = history.length - 1
    }
    function listen(target: EventTarget, name: string, handler: EventListener, capture = false) {
        target.addEventListener(name, handler, capture)
        listeners.push(() => target.removeEventListener(name, handler, capture))
    }
    function close() {
        version++
        pending?.abort()
        pending = undefined
        popup?.remove()
        popup = undefined
        items = []
        range = null
        input.setAttribute('aria-expanded', 'false')
        input.removeAttribute('aria-controls')
        input.removeAttribute('aria-activedescendant')
    }
    function dismiss() { dismissed = true; close() }
    function position() {
        if (!popup) return
        const view = window.visualViewport
        const viewport = { left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0,
            width: view?.width ?? window.innerWidth, height: view?.height ?? window.innerHeight }
        const font = getComputedStyle(input)
        popup.style.font = font.font
        popup.style.fontSize = font.fontSize
        const width = Math.max(0, Math.min(420, viewport.width - 12))
        popup.style.width = `${width}px`
        const caret = textareaCaret(input)
        const bounds = input.getBoundingClientRect()
        if (caret.bottom < Math.max(bounds.top, viewport.top) || caret.top > Math.min(bounds.bottom, viewport.top + viewport.height)) { dismiss(); return }
        const pos = popupPosition(caret, width, Math.min(popup.scrollHeight || 320, 320), viewport)
        Object.assign(popup.style, { left: `${pos.left}px`, top: `${pos.top}px`, maxHeight: `${pos.maxHeight}px` })
    }
    function activate(index: number) {
        selected = (index + items.length) % items.length
        if (!popup) return
        Array.from(popup.children).forEach((node, i) => node.setAttribute('aria-selected', String(i === selected)))
        const option = popup.children[selected] as HTMLElement
        input.setAttribute('aria-activedescendant', option.id)
        // Scroll this list only; scrollIntoView can move the whole modal/editor.
        if (option.offsetTop < popup.scrollTop) popup.scrollTop = option.offsetTop
        else if (option.offsetTop + option.offsetHeight > popup.scrollTop + popup.clientHeight)
            popup.scrollTop = option.offsetTop + option.offsetHeight - popup.clientHeight
    }
    function emitInput() {
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }))
    }
    function accept(index: number) {
        if (!range || !requested || !unchanged(requested) || !items[index]) { dismiss(); return }
        const item = items[index]
        const word = item.redirect && item.redirect.trim() !== 'null' ? item.redirect.trim() : item.word
        const { start, end } = range
        record()
        dismiss()
        input.focus({ preventScroll: true })
        inserting = true
        input.setSelectionRange(start, end)
        let inserted = false
        try { inserted = document.execCommand?.('insertText', false, word) ?? false } catch { /* Native command unavailable. */ }
        if (!inserted) { input.setRangeText(word, start, end, 'end'); fallbackHistory = true }
        input.setSelectionRange(start + word.length, start + word.length)
        // execCommand emits input in supported browsers; this also synchronizes Svelte bindings on fallback.
        if (!inserted) emitInput()
        inserting = false
        record()
    }
    function render(found: TagSuggestion[], query: string) {
        items = found
        selected = 0
        popup = document.createElement('div')
        popup.id = id
        popup.className = 'tag-autocomplete-list'
        popup.setAttribute('role', 'listbox')
        popup.setAttribute('aria-label', 'Danbooru 태그 자동완성')
        popup.setAttribute('popover', 'manual')
        found.forEach((item, index) => {
            const option = document.createElement('div')
            option.id = `${id}-${index}`
            option.className = 'tag-autocomplete-option'
            option.setAttribute('role', 'option')
            const name = document.createElement('span')
            name.className = 'tag-autocomplete-name'
            for (const part of highlightTagMatch(item.word, query)) {
                const span = document.createElement(part.match ? 'mark' : 'span')
                span.textContent = part.text
                name.append(span)
            }
            const detail = document.createElement('small')
            detail.textContent = `${categories[item.category] ?? `분류 ${item.category}`} / ${item.frequency.toLocaleString()}`
            option.append(name, detail)
            if (item.redirect && item.redirect.trim() !== 'null') {
                const redirect = document.createElement('span')
                redirect.className = 'tag-autocomplete-redirect'
                redirect.textContent = `→ ${item.redirect}`
                option.append(redirect)
            }
            option.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation() })
            option.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); accept(index) })
            popup!.append(option)
        })
        // Remain a modal descendant for focus/outside-click guards. Popover's top layer avoids clipping.
        ;(input.closest('[role="dialog"], [role="alertdialog"]') ?? document.body).append(popup)
        try { popup.showPopover?.() } catch { /* Fixed-position fallback for older WebViews. */ }
        input.setAttribute('aria-expanded', 'true')
        input.setAttribute('aria-controls', id)
        position()
        if (popup) activate(0)
    }
    async function search() {
        close()
        if (destroyed || dismissed || composing || !settings.enabled || input.disabled || input.readOnly || document.activeElement !== input) return
        range = tagRange(input.value, input.selectionStart, input.selectionEnd, settings.scope)
        if (!range || [...range.query].length < settings.minLength) return
        const currentRange = range
        const current = snapshot()
        requested = current
        const requestVersion = version
        pending = new AbortController()
        try {
            const found = await searchTags(range.query, pending.signal)
            if (destroyed || requestVersion !== version || composing || document.activeElement !== input || !unchanged(current)) return
            if (!found.length) { close(); return }
            range = currentRange
            render(found, currentRange.query)
        } catch { if (requestVersion === version) close() }
    }
    function onInput(event: Event) {
        if (inserting) return
        record()
        if (composing || (event as InputEvent).isComposing) { close(); return }
        dismissed = false
        if (/\s$/.test((event as InputEvent).data ?? '') || /[,\n\r]/.test((event as InputEvent).data ?? '')) { dismiss(); return }
        void search()
    }
    function undo(direction: number) {
        const next = historyIndex + direction
        if (next < 0 || next >= history.length) return
        historyIndex = next
        const value = history[next]
        inserting = true
        input.value = value.text
        input.setSelectionRange(value.start, value.end)
        emitInput()
        inserting = false
        dismiss()
    }
    function keydown(event: KeyboardEvent) {
        if (event.target !== input || destroyed) return
        if (composing || event.isComposing || event.keyCode === 229 || (performance.now() - compositionEndedAt < 50 && event.key === 'Enter')) {
            // Keep the native IME default, but shield app send/save/escape listeners (including capture).
            event.stopImmediatePropagation()
            return
        }
        compositionEndedAt = -Infinity
        if ([' ', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) ||
            ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && event.shiftKey)) { dismiss(); return }
        if (popup && items.length) {
            const action = (['close', 'accept', 'previous', 'next'] as const)
                .find(action => settings.hotkeys[action].some(binding => matchesTagHotkey(event, binding)))
            if (action) {
                event.preventDefault(); event.stopImmediatePropagation()
                if (action === 'accept') accept(selected)
                else if (action === 'close') dismiss()
                else activate(selected + (action === 'next' ? 1 : -1))
                return
            }
        }
        if (fallbackHistory && (event.ctrlKey !== event.metaKey) && !event.altKey &&
            (event.key.toLowerCase() === 'z' || (event.key.toLowerCase() === 'y' && !event.shiftKey))) {
            event.preventDefault(); event.stopImmediatePropagation()
            undo(event.key.toLowerCase() === 'y' || event.shiftKey ? 1 : -1)
            return
        }
        if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) dismiss()
    }
    input.setAttribute('role', 'combobox')
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-haspopup', 'listbox')
    input.setAttribute('aria-expanded', 'false')
    listen(input, 'input', onInput)
    listen(input, 'blur', () => { compositionEndedAt = -Infinity; dismiss() })
    listen(input, 'pointerdown', dismiss)
    listen(input, 'compositionstart', () => { composing = true; compositionEndedAt = -Infinity; close() })
    listen(input, 'compositionend', () => { composing = false; compositionEndedAt = performance.now(); dismissed = false; queueMicrotask(() => { if (!destroyed) void search() }) })
    listen(input, 'keyup', (event: KeyboardEvent) => { if (event.key === 'Enter') compositionEndedAt = -Infinity })
    // Window capture runs before modal Escape/document shortcuts, but only for this input.
    listen(window, 'keydown', keydown, true)
    listen(document, 'pointerdown', event => { if (event.target !== input && !popup?.contains(event.target as Node)) dismiss() }, true)
    listen(document, 'selectionchange', () => { if (requested && !unchanged(requested)) dismiss() })
    listen(input, 'select', () => { if (requested && !unchanged(requested)) dismiss() })
    listen(input, 'beforeinput', (event: InputEvent) => {
        if (fallbackHistory && ['historyUndo', 'historyRedo'].includes(event.inputType)) {
            event.preventDefault(); undo(event.inputType === 'historyUndo' ? -1 : 1)
        }
    })
    listen(window, 'resize', position)
    listen(document, 'scroll', position, true)
    if (window.visualViewport) { listen(window.visualViewport, 'resize', position); listen(window.visualViewport, 'scroll', position) }
    return {
        update(next: TagAutocompleteSettings) { settings = next; if (!dismissed) void search(); else close() },
        destroy() {
            if (destroyed) return
            destroyed = true
            close()
            listeners.forEach(remove => remove())
            aria.forEach((name, index) => { const value = originalAria[index]; if (value === null) input.removeAttribute(name); else input.setAttribute(name, value) })
        },
    }
}
