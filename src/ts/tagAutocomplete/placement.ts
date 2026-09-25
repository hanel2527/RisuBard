export function popupPosition(caret: { left: number; top: number; bottom: number }, width: number, height: number,
    viewport: { left: number; top: number; width: number; height: number }) {
    const gap = 6
    const below = viewport.top + viewport.height - caret.bottom - gap
    const above = caret.top - viewport.top - gap
    const maxHeight = Math.max(0, Math.min(height, Math.max(above, below), viewport.height - 2 * gap))
    return {
        left: Math.max(viewport.left + gap, Math.min(caret.left, viewport.left + viewport.width - width - gap)),
        top: Math.max(viewport.top + gap, below >= maxHeight ? caret.bottom + gap : caret.top - maxHeight - gap),
        maxHeight,
    }
}

/** Mirror browser wrapping and scroll, including the textarea's actual font and box model. */
export function textareaCaret(input: HTMLTextAreaElement) {
    const style = getComputedStyle(input)
    const mirror = document.createElement('div')
    for (const key of ['boxSizing', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
        'textTransform', 'textIndent', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderLeftWidth', 'borderRightWidth', 'borderBottomWidth', 'wordBreak'] as const) mirror.style[key] = style[key]
    Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
        whiteSpace: input.wrap === 'off' ? 'pre' : 'pre-wrap', overflowWrap: 'break-word',
        width: `${input.clientWidth + input.clientLeft * 2}px`, borderStyle: 'solid', left: '0', top: '0' })
    mirror.textContent = input.value.slice(0, input.selectionStart)
    const marker = document.createElement('span')
    marker.textContent = input.value.slice(input.selectionStart) || '\u200b'
    mirror.append(marker)
    document.body.append(mirror)
    const rect = input.getBoundingClientRect()
    const point = marker.getClientRects()[0] ?? marker.getBoundingClientRect()
    const origin = mirror.getBoundingClientRect()
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.55 || 20
    const left = rect.left + point.left - origin.left - input.scrollLeft
    const top = rect.top + point.top - origin.top - input.scrollTop
    mirror.remove()
    return { left: Math.max(rect.left, Math.min(left, rect.right)), top, bottom: top + lineHeight }
}
