const MODAL_SELECTOR = '.risu-modal-overlay, .risu-modal-surface'
const MODAL_LAYER_BASE = 1_000_000

function isOpeningMutation(element: Element, attributeName: string | null): boolean {
    if (attributeName === 'data-state') return element.getAttribute('data-state') === 'open'
    if (attributeName === 'hidden') return !element.hasAttribute('hidden')
    if (attributeName === 'open') return element.hasAttribute('open')
    return true
}

function pairedSurface(overlay: Element): Element | undefined {
    const nested = overlay.querySelector('.risu-modal-surface')
    if (nested) return nested

    for (let sibling = overlay.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        if (sibling.matches('.risu-modal-overlay')) return undefined
        if (sibling.matches('.risu-modal-surface')) return sibling
    }
    return undefined
}

export function observeModalLayers(root: ParentNode): () => void {
    let nextLayer = MODAL_LAYER_BASE

    const raise = (element: Element) => {
        if (!(element instanceof HTMLElement)) return
        nextLayer += 1
        element.style.zIndex = String(nextLayer)
        element.dataset.risuModalLayer = String(nextLayer)
        if (element.matches('.risu-modal-overlay')) {
            const surface = pairedSurface(element)
            if (surface) raise(surface)
        }
    }

    const collect = (node: Node, targets: Set<Element>) => {
        if (!(node instanceof Element)) return
        if (node.matches(MODAL_SELECTOR)) targets.add(node)
        for (const element of node.querySelectorAll(MODAL_SELECTOR)) targets.add(element)
    }

    for (const element of root.querySelectorAll(MODAL_SELECTOR)) raise(element)

    const observer = new MutationObserver((records) => {
        const targets = new Set<Element>()
        for (const record of records) {
            if (record.type === 'childList') {
                for (const node of record.addedNodes) collect(node, targets)
                continue
            }
            const target = record.target
            if (target instanceof Element
                && target.matches(MODAL_SELECTOR)
                && isOpeningMutation(target, record.attributeName)) {
                targets.add(target)
            }
        }
        for (const target of targets) raise(target)
    })

    observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'data-state', 'hidden', 'open'],
    })

    return () => observer.disconnect()
}
