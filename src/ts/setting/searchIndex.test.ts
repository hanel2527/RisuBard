import { describe, expect, test, vi } from 'vitest'
import { navigateToSearchResult, searchSettings } from './searchIndex'
import { SettingsRoute } from '../routing'
import { get } from 'svelte/store'
import { SettingsMenuIndex, OtherBotsSubmenuIndex } from '../stores.svelte'

// A settings entry is reachable two ways and they cover different text: the
// declarative items index each SETTING's label/keywords/help, while the manifest
// indexes the TAB name (which is only breadcrumb text on the declarative side).
// Searching the name printed on the tab must find it.
//
// Conditions across the other settings pages dereference arbitrary db fields
// (db.aiModel.startsWith(...), db.someList.includes(...)). A proxy answering ''
// for anything unset satisfies both string and array-ish probes, so the search
// walks every source the way it does in the app.
const db: any = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : '') })
const modelInfo: any = new Proxy({}, { get: () => '' })
const ctx = { db, modelInfo, subModelInfo: modelInfo } as any

test('Hypa embedding deep link switches page and subtab then scrolls after mounting', () => {
    let nextFrame: FrameRequestCallback | undefined
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { nextFrame = callback; return 1 })
    const previousRoute = get(SettingsMenuIndex)
    const previousTab = get(OtherBotsSubmenuIndex)
    const anchor = document.createElement('div')
    anchor.dataset.settingId = 'hypa.embedding'
    const scroll = vi.spyOn(anchor, 'scrollIntoView').mockImplementation(() => {})
    anchor.animate = vi.fn() as typeof anchor.animate
    try {
        OtherBotsSubmenuIndex.set(3)
        navigateToSearchResult({ key: 'hypa.embedding', label: '', location: '', rank: 0,
            route: SettingsRoute.OtherBots, subTab: 0, itemId: 'hypa.embedding' })
        expect(get(SettingsMenuIndex)).toBe(SettingsRoute.OtherBots)
        expect(get(OtherBotsSubmenuIndex)).toBe(0)
        expect(nextFrame).toBeDefined()
        document.body.appendChild(anchor)
        nextFrame!(0)
        expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    } finally {
        anchor.remove()
        frame.mockRestore()
        SettingsMenuIndex.set(previousRoute)
        OtherBotsSubmenuIndex.set(previousTab)
    }
})

/** Sub-tab indices of every Model Preset hit. Locale-independent, unlike the
 * label — the test runtime has no locale set, so labels come back in English. */
function moduleTabHits(query: string): number[] {
    return searchSettings(query, ctx)
        .filter((r) => r.route === SettingsRoute.ModelPreset && r.subTab === 3)
        .map((r) => r.subTab!)
}

describe('searchSettings — module binding tab', () => {
    test('finds the tab by the name shown on it', () => {
        expect(moduleTabHits('모듈 분리 바인딩').length).toBeGreaterThan(0)
    })

    test('finds it without spaces', () => {
        expect(moduleTabHits('모듈분리바인딩').length).toBeGreaterThan(0)
    })

    test('finds it in English', () => {
        expect(moduleTabHits('module binding').length).toBeGreaterThan(0)
    })

    test('finds the toggle setting via its own keywords', () => {
        expect(moduleTabHits('모듈별').length).toBeGreaterThan(0)
    })

    test('an unrelated query does not hit the tab', () => {
        expect(moduleTabHits('persona')).toEqual([])
    })
})

describe('searchSettings — unified RisuBard common settings', () => {
    test('routes legacy chat-mode searches to common settings', () => {
        const hits = searchSettings('채팅 모드', ctx)

        expect(hits.some((result) => result.route === SettingsRoute.RisuBardCommon)).toBe(true)
        expect(hits.every((result) => result.route !== SettingsRoute.RisuBardChat)).toBe(true)
    })
})

describe('searchSettings — storage diagnostics', () => {
    test('finds the public developer diagnostics page', () => {
        const hits = searchSettings('저장 진단', ctx)

        expect(hits.some((result) => result.route === (SettingsRoute as any).Developer)).toBe(true)
    })
})
