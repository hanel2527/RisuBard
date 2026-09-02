import tippy from 'tippy.js'
import 'tippy.js/dist/tippy.css';
import '../../styles/tooltip-theme.css';
import { layerAbove } from 'src/lib/UI/GUI/modalLayerStack';

export function tooltip(node:HTMLElement, tip:string) {
    const instance = tippy(node, {
        content: tip,
        animation: 'fade',
        arrow: true,
        theme: 'risubard',
        onCreate(instance) {
            instance.popper.dataset.risuFloatingLayer = ''
        },
        onShow(instance) {
            instance.setProps({ zIndex: layerAbove(node) })
        },
    })
    return {
        update(newTip: string) {
            instance.setContent(newTip)
        },
        destroy() {
            instance.destroy()
        }
    };
}

export function tooltipRight(node:HTMLElement, tip:string) {
    const instance = tippy(node, {
        content: tip,
        animation: 'fade',
        arrow: true,
        placement: 'right',
        theme: 'risubard',
        onCreate(instance) {
            instance.popper.dataset.risuFloatingLayer = ''
        },
        onShow(instance) {
            instance.setProps({ zIndex: layerAbove(node) })
        },
    })
    return {
        update(newTip: string) {
            instance.setContent(newTip)
        },
        destroy() {
            instance.destroy()
        }
    };
}

export function tooltipLeft(node:HTMLElement, tip:string) {
    const instance = tippy(node, {
        content: tip,
        animation: 'fade',
        arrow: true,
        placement: 'left',
        theme: 'risubard',
        onCreate(instance) {
            instance.popper.dataset.risuFloatingLayer = ''
        },
        onShow(instance) {
            instance.setProps({ zIndex: layerAbove(node) })
        },
    })
    return {
        update(newTip: string) {
            instance.setContent(newTip)
        },
        destroy() {
            instance.destroy()
        }
    };
}
