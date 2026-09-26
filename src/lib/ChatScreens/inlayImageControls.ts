export function removeInlayOccurrence(data: string, id: string, occurrence: number): string {
    let seen = 0
    return data.replace(/{{(?:inlay|inlayed|inlayeddata)::(.+?)}}/g, (token, tokenId) => {
        if (tokenId !== id) return token
        return seen++ === occurrence ? '' : token
    })
}

type RemoveInlay = (id: string, occurrence: number) => void

/** Decorate only resolved inlay images, including images loaded after HTML rendering. */
export function inlayImageControls(root: HTMLElement, initial?: RemoveInlay) {
    let onRemove = initial
    const wrappers = new Set<HTMLElement>()

    function refresh() {
        for (const wrapper of wrappers) {
            if (!root.contains(wrapper) || !wrapper.querySelector('img[data-inlay-image-id]') || !onRemove) {
                wrapper.querySelector('button')?.remove()
                wrapper.replaceWith(...wrapper.childNodes)
                wrappers.delete(wrapper)
            }
        }
        if (!onRemove) return
        for (const image of root.querySelectorAll<HTMLImageElement>('img[data-inlay-image-id]')) {
            if (image.parentElement?.classList.contains('inlay-image-control')) continue
            const wrapper = document.createElement('span')
            wrapper.className = 'inlay-image-control'
            const button = document.createElement('button')
            button.type = 'button'
            button.className = 'inlay-image-remove'
            button.title = '본문에서 이미지 삭제'
            button.setAttribute('aria-label', button.title)
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>'
            button.addEventListener('click', event => {
                event.preventDefault()
                event.stopPropagation()
                const occurrence = Number(image.dataset.inlayOccurrence)
                if (Number.isInteger(occurrence) && occurrence >= 0) {
                    onRemove?.(image.dataset.inlayImageId!, occurrence)
                }
            })
            image.replaceWith(wrapper)
            wrapper.append(image, button)
            wrappers.add(wrapper)
        }
    }

    const observer = new MutationObserver(refresh)
    observer.observe(root, { childList: true, subtree: true })
    refresh()
    return {
        update(callback?: RemoveInlay) { onRemove = callback; refresh() },
        destroy() { observer.disconnect() },
    }
}
