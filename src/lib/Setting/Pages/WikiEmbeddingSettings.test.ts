import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { writable } from 'svelte/store'
import { testEmbeddingState } from './embeddingSettingsState.svelte'

vi.mock('src/ts/stores.svelte', async () => ({
    DBState: (await import('./embeddingSettingsState.svelte')).testEmbeddingState,
    isTouchDevice: writable(false),
}))
vi.mock('src/ts/routing', () => ({ SettingsRoute: { OtherBots: 'OtherBots' } }))
vi.mock('src/ts/setting/searchIndex', () => ({ navigateToSearchResult: vi.fn() }))
vi.mock('src/ts/alert', () => ({ alertMd: vi.fn() }))
import { navigateToSearchResult } from 'src/ts/setting/searchIndex'
import WikiEmbeddingSettings from './WikiEmbeddingSettings.svelte'
import SharedEmbeddingSettings from './SharedEmbeddingSettings.svelte'

let component: ReturnType<typeof mount> | undefined
beforeEach(() => {
    vi.clearAllMocks()
    testEmbeddingState.db.risuBardEmbeddingSettings.enabled = false
    testEmbeddingState.db.hypaModel = 'multiMiniLM'
    Object.assign(testEmbeddingState.db.hypaCustomSettings, { url: '', key: '', model: '' })
})
afterEach(async () => { if (component) await unmount(component); document.body.innerHTML = ''; component = undefined })

test('common settings keeps only enable and model navigation, even when enabled', () => {
    component = mount(WikiEmbeddingSettings, { target: document.body })
    flushSync()
    const toggle = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    const button = document.querySelector<HTMLButtonElement>('button')!
    expect(button.textContent).toBe('모델 설정')
    expect(button.parentElement).toBe(toggle.closest('label')?.parentElement)
    expect(button.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    button.click()
    expect(navigateToSearchResult).toHaveBeenCalledWith(expect.objectContaining({ route: 'OtherBots', subTab: 0, itemId: 'hypa.embedding' }))
    toggle.click()
    flushSync()
    expect(testEmbeddingState.db.risuBardEmbeddingSettings.enabled).toBe(true)
    expect(document.querySelector('[role="combobox"]')).toBeNull()
    expect(document.querySelector('[data-shared-embedding-settings]')).toBeNull()
    expect(document.querySelectorAll('button')).toHaveLength(1)
    expect(testEmbeddingState.db.hypaModel).toBe('multiMiniLM')
})

test('Hypa target exposes custom connection fields without a model-specific shortcut', () => {
    component = mount(SharedEmbeddingSettings, { target: document.body })
    flushSync()
    expect(document.querySelector('[data-setting-id="hypa.embedding"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('OpenRouter Qwen3')
    const trigger = document.querySelector<HTMLElement>('[role="combobox"]')!
    trigger.click()
    flushSync()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const custom = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find(option => option.textContent?.includes('Custom'))!
    custom.click()
    flushSync()
    expect(testEmbeddingState.db.hypaModel).toBe('custom')
    expect(document.body.textContent).toContain('Request Model')
    const key = document.querySelector<HTMLInputElement>('input[type="password"]')!
    key.value = 'test-key'
    key.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    expect(testEmbeddingState.db.hypaCustomSettings.key).toBe('test-key')
})
