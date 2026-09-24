import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('chat scroll anchor integration', () => {
    test('connects layout stabilization to the default chat screen', () => {
        const source = read('src/lib/ChatScreens/DefaultChatScreen.svelte')

        expect(source).toContain("from './chatScrollAnchor'")
        expect(source).toContain('observeChatScroll(container, captureCurrentScrollAnchor')
        expect(source).toContain('DBState.db.preserveChatScrollPosition')
    })

    test('exposes a default-on toggle in Accessibility > Scroll', () => {
        const database = read('src/ts/storage/database.svelte.ts')
        const settings = read('src/ts/setting/accessibilitySettingsData.ts')

        expect(database).toContain('data.preserveChatScrollPosition ??= true')
        expect(database).toContain('preserveChatScrollPosition?: boolean')
        expect(settings).toContain("id: 'acc.preserveChatScrollPosition'")
        expect(settings).toMatch(/accessibilityScrollItems[\s\S]*'acc\.preserveChatScrollPosition'/)
    })
})
