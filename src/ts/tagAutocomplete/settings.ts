import type { Hotkey } from '../defaulthotkeys'

export type TagHotkey = Hotkey & { meta?: boolean }
export type TagHotkeyAction = 'previous' | 'next' | 'accept' | 'close'
export interface TagAutocompleteSettings {
    enabled: boolean
    minLength: number
    scope: 'left' | 'whole'
    hotkeys: Record<TagHotkeyAction, TagHotkey[]>
}

export const tagHotkeyLabels: Record<TagHotkeyAction, string> = {
    previous: '이전 후보', next: '다음 후보', accept: '후보 확정', close: '목록 닫기',
}

const defaultKeys: Record<TagHotkeyAction, string[]> = {
    previous: ['ArrowUp'], next: ['ArrowDown'], accept: ['Enter', 'Tab'], close: ['Escape'],
}
const modifierKeys = ['Control', 'Shift', 'Alt', 'Meta', 'Unidentified', 'Process']

export function normalizeTagAutocompleteSettings(raw?: unknown): TagAutocompleteSettings {
    const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const rawHotkeys = source.hotkeys && typeof source.hotkeys === 'object'
        ? source.hotkeys as Record<string, unknown> : {}
    const hotkeys = {} as TagAutocompleteSettings['hotkeys']
    for (const action of Object.keys(defaultKeys) as TagHotkeyAction[]) {
        const candidates = rawHotkeys[action]
        const valid = Array.isArray(candidates) ? candidates.filter(binding =>
            binding && typeof binding.key === 'string' && binding.key.length > 0 && !modifierKeys.includes(binding.key)
        ) : []
        hotkeys[action] = (valid.length ? valid : defaultKeys[action].map(key => ({ key }))).map(binding => ({
            key: binding.key, ctrl: binding.ctrl === true, alt: binding.alt === true,
            shift: binding.shift === true, meta: binding.meta === true, action: `tagAutocomplete.${action}`,
        }))
    }
    const length = Number(source.minLength)
    return {
        enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
        minLength: Number.isFinite(length) ? Math.max(1, Math.min(10, Math.trunc(length))) : 1,
        scope: source.scope === 'whole' ? 'whole' : 'left',
        hotkeys,
    }
}

export function matchesTagHotkey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'> & { isComposing?: boolean }, binding: TagHotkey): boolean {
    return !event.isComposing && event.key.toLowerCase() === binding.key.toLowerCase()
        && !!event.ctrlKey === !!binding.ctrl && !!event.altKey === !!binding.alt
        && !!event.shiftKey === !!binding.shift && !!event.metaKey === !!binding.meta
}

export function formatTagHotkey(binding: TagHotkey): string {
    return [binding.ctrl && 'Ctrl', binding.alt && 'Alt', binding.shift && 'Shift', binding.meta && 'Meta',
        binding.key === ' ' ? 'Space' : binding.key].filter(Boolean).join('+')
}

export function getTagHotkeyWarnings(settings: TagAutocompleteSettings, globalHotkeys: Hotkey[] = []): string[] {
    const warnings = new Set<string>()
    const seen = new Map<string, string>()
    for (const action of Object.keys(settings.hotkeys) as TagHotkeyAction[]) {
        for (const binding of settings.hotkeys[action]) {
            const label = formatTagHotkey(binding)
            const signature = label.toLowerCase()
            const previous = seen.get(signature)
            if (previous) warnings.add(`${label}: ${previous} / ${tagHotkeyLabels[action]} 중복. 목록 닫기, 확정, 이전, 다음 순서가 우선합니다.`)
            seen.set(signature, tagHotkeyLabels[action])
            const event = { key: binding.key, ctrlKey: !!binding.ctrl, altKey: !!binding.alt, shiftKey: !!binding.shift, metaKey: !!binding.meta }
            for (const global of globalHotkeys) {
                if (matchesTagHotkey(event, global)) warnings.add(`${label}: 공통 단축키 ${global.action}와 충돌합니다. 후보가 열려 있으면 자동완성이 우선합니다.`)
            }
            if ((binding.ctrl || binding.meta) && !binding.alt) {
                const editor = { z: '실행 취소', y: '다시 실행', a: '전체 선택', x: '잘라내기', c: '복사', v: '붙여넣기', s: '저장', arrowup: '가중치 조절', arrowdown: '가중치 조절' }[binding.key.toLowerCase()]
                if (editor) warnings.add(`${label}: 에디터 ${editor}와 충돌합니다. 후보가 열려 있으면 자동완성이 우선합니다.`)
            }
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(binding.key)
                || (binding.shift && ['ArrowUp', 'ArrowDown'].includes(binding.key))) {
                warnings.add(`${label}: 커서 이동 또는 공백 입력은 목록을 닫고 원래 편집 동작을 수행하므로 자동완성 키로 사용할 수 없습니다.`)
            }
        }
    }
    return [...warnings]
}
