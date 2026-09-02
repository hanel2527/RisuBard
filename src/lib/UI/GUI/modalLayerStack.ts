export const OVERLAY_LAYERS = {
    floating: 90,
    base: 100,
    alert: 300,
    notification: 600,
    top: 700,
    drag: 900,
} as const

export type ModalLayerTier = 'base' | 'alert' | 'top'

const MODAL_SELECTOR = '.risu-modal-overlay, .risu-modal-surface, [data-risu-modal-tier]'
const FLOATING_SELECTOR = '[data-risu-floating-layer]'
const MODAL_LAYER_STRIDE = 2
const MODAL_LAYER_CEILINGS: Record<ModalLayerTier, number> = {
    base: OVERLAY_LAYERS.alert - 1,
    alert: OVERLAY_LAYERS.notification - 1,
    top: OVERLAY_LAYERS.drag - 1,
}
const modalStacks: Record<ModalLayerTier, HTMLElement[]> = {
    base: [],
    alert: [],
    top: [],
}

function isOpeningMutation(element: Element, attributeName: string | null): boolean {
    if (attributeName === 'data-state') return element.getAttribute('data-state') === 'open'
    if (attributeName === 'hidden') return !element.hasAttribute('hidden')
    if (attributeName === 'open') return element.hasAttribute('open')
    return true
}

function pairedSurface(overlay: Element): HTMLElement | undefined {
    const nested = overlay.querySelector<HTMLElement>('.risu-modal-surface')
    if (nested) return nested

    for (let sibling = overlay.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        if (sibling.matches('.risu-modal-overlay')) return undefined
        if (sibling instanceof HTMLElement && sibling.matches('.risu-modal-surface')) return sibling
    }
    return undefined
}

function pairedOverlay(surface: Element): HTMLElement | undefined {
    const nested = surface.parentElement?.closest<HTMLElement>('.risu-modal-overlay')
    if (nested) return nested

    for (let sibling = surface.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.matches('.risu-modal-surface')) return undefined
        if (sibling instanceof HTMLElement && sibling.matches('.risu-modal-overlay')) return sibling
    }
    return undefined
}

function modalKey(element: HTMLElement): HTMLElement {
    if (element.matches('.risu-modal-overlay')) return element
    if (element.matches('.risu-modal-surface')) return pairedOverlay(element) ?? element
    return element
}

function modalElements(key: HTMLElement): { overlay?: HTMLElement; surface?: HTMLElement } {
    if (key.matches('.risu-modal-overlay')) return { overlay: key, surface: pairedSurface(key) }
    if (key.matches('.risu-modal-surface')) return { surface: key }
    return { surface: key }
}

function modalTier(key: HTMLElement): ModalLayerTier {
    const { overlay, surface } = modalElements(key)
    const tier = surface?.dataset.risuModalTier ?? overlay?.dataset.risuModalTier ?? key.dataset.risuModalTier
    return tier === 'base' || tier === 'top' ? tier : 'alert'
}

function setLayer(element: HTMLElement | undefined, layer: number): void {
    if (!element) return
    const value = String(layer)
    if (element.style.zIndex !== value) element.style.zIndex = value
    if (element.dataset.risuModalLayer !== value) element.dataset.risuModalLayer = value
}

function visibilityStyleChanged(element: HTMLElement, oldValue: string | null): boolean {
    const previous = document.createElement('div').style
    previous.cssText = oldValue ?? ''
    return previous.display !== element.style.display || previous.visibility !== element.style.visibility
}

function isActive(element: HTMLElement | undefined): boolean {
    for (let current: HTMLElement | null | undefined = element; current; current = current.parentElement) {
        if (current.hidden
            || current.getAttribute('data-state') === 'closed'
            || current.getAttribute('aria-hidden') === 'true'
            || current.matches('dialog:not([open])')) return false
        const style = getComputedStyle(current)
        if (style.display === 'none' || style.visibility === 'hidden') return false
    }
    return Boolean(element?.isConnected)
}

function isActiveModal(key: HTMLElement): boolean {
    const { overlay, surface } = modalElements(key)
    return isActive(surface ?? overlay)
}

function applyModalLayers(): void {
    for (const tier of ['base', 'alert', 'top'] as const) {
        const stack = modalStacks[tier]
        const connected = stack.filter((key, index) => isActiveModal(key) && stack.indexOf(key) === index)
        stack.splice(0, stack.length, ...connected)

        stack.forEach((key, index) => {
            const { overlay, surface } = modalElements(key)
            const layer = Math.min(
                OVERLAY_LAYERS[tier] + index * MODAL_LAYER_STRIDE,
                MODAL_LAYER_CEILINGS[tier] - 1,
            )
            setLayer(overlay, layer)
            setLayer(surface, overlay ? layer + 1 : layer)
        })
    }
}

function raiseModal(element: HTMLElement): void {
    const key = modalKey(element)
    for (const stack of Object.values(modalStacks)) {
        const index = stack.indexOf(key)
        if (index >= 0) stack.splice(index, 1)
    }
    modalStacks[modalTier(key)].push(key)
    applyModalLayers()
}

export function layerAbove(reference: Element | null, fallback = OVERLAY_LAYERS.floating): number {
    let highest = fallback - 1
    for (let element: Element | null = reference; element; element = element.parentElement) {
        const value = Number.parseInt(getComputedStyle(element).zIndex, 10)
        if (Number.isFinite(value)) highest = Math.max(highest, value)
    }
    const ceiling = highest < OVERLAY_LAYERS.base ? OVERLAY_LAYERS.base - 1
        : highest < OVERLAY_LAYERS.alert ? OVERLAY_LAYERS.alert - 1
            : highest < OVERLAY_LAYERS.notification ? OVERLAY_LAYERS.notification - 1
                : highest < OVERLAY_LAYERS.top ? OVERLAY_LAYERS.top - 1
                    : OVERLAY_LAYERS.drag - 1
    return Math.min(ceiling, Math.max(fallback, highest + 1))
}

function ariaOwner(element: HTMLElement, root: ParentNode): HTMLElement | undefined {
    const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? []
    for (const id of labelledBy) {
        const owner = document.getElementById(id)
        if (owner) return owner
    }

    if (!element.id) return undefined
    for (const candidate of root.querySelectorAll<HTMLElement>('[aria-controls], [aria-describedby]')) {
        const controls = candidate.getAttribute('aria-controls')?.split(/\s+/) ?? []
        const describedBy = candidate.getAttribute('aria-describedby')?.split(/\s+/) ?? []
        if (controls.includes(element.id) || describedBy.includes(element.id)) return candidate
    }
    return undefined
}

function highestModalSurface(): HTMLElement | undefined {
    return Object.values(modalStacks)
        .flatMap((stack) => stack.filter(isActiveModal).map((key) => modalElements(key).surface)
            .filter((value): value is HTMLElement => Boolean(value)))
        .sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0]
}

function applyFloatingLayer(element: HTMLElement, root: ParentNode): void {
    const localOwner = element.parentElement && element.parentElement !== document.body
        ? element.parentElement
        : undefined
    const owner = element.parentElement?.closest<HTMLElement>('.risu-modal-surface')
        ?? ariaOwner(element, root)
        ?? localOwner
        ?? highestModalSurface()
    element.style.zIndex = String(layerAbove(owner))
}

export function observeModalLayers(root: ParentNode): () => void {
    const floatingElements = new Set<HTMLElement>()

    const refreshFloatingLayers = () => {
        for (const element of floatingElements) {
            if (!element.isConnected) floatingElements.delete(element)
            else applyFloatingLayer(element, root)
        }
    }

    const process = (element: HTMLElement) => {
        if (element.matches(MODAL_SELECTOR)) raiseModal(element)
        if (element.matches(FLOATING_SELECTOR)) {
            floatingElements.add(element)
            applyFloatingLayer(element, root)
        }
    }

    const collect = (node: Node, targets: Set<HTMLElement>) => {
        if (!(node instanceof HTMLElement)) return
        if (node.matches(`${MODAL_SELECTOR}, ${FLOATING_SELECTOR}`)) targets.add(node)
        for (const element of node.querySelectorAll<HTMLElement>(`${MODAL_SELECTOR}, ${FLOATING_SELECTOR}`)) targets.add(element)
    }

    for (const element of root.querySelectorAll<HTMLElement>(`${MODAL_SELECTOR}, ${FLOATING_SELECTOR}`)) process(element)

    const observer = new MutationObserver((records) => {
        const targets = new Set<HTMLElement>()
        for (const record of records) {
            if (record.type === 'childList') {
                for (const node of record.addedNodes) collect(node, targets)
                continue
            }
            const target = record.target
            if (target instanceof HTMLElement) {
                if (target.matches(`${MODAL_SELECTOR}, ${FLOATING_SELECTOR}`)
                    && isOpeningMutation(target, record.attributeName)) targets.add(target)
                if ((record.attributeName === 'style' && visibilityStyleChanged(target, record.oldValue))
                    || record.attributeName === 'hidden'
                    || record.attributeName === 'aria-hidden') collect(target, targets)
            }
        }
        for (const target of targets) process(target)
        applyModalLayers()
        refreshFloatingLayers()
    })

    observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ['class', 'style', 'data-state', 'hidden', 'open', 'aria-hidden', 'data-risu-modal-tier', 'data-risu-floating-layer'],
    })

    return () => {
        observer.disconnect()
        floatingElements.clear()
        for (const stack of Object.values(modalStacks)) stack.length = 0
    }
}
