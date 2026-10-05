// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import { language } from 'src/lang'
import { createDefaultWikiPromptPreset, duplicateWikiPromptPreset } from 'src/ts/risubard/wikiPromptPreset'
import RisuBardWikiPromptV2Workspace from './RisuBardWikiPromptV2Workspace.svelte'

vi.mock('src/ts/stores.svelte', () => ({
    DBState: { db: { customPromptTemplateToggle: '', globalChatVariables: {} } },
    selIdState: { selId: undefined },
}))

let mounted: ReturnType<typeof mount> | undefined

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('RisuBard wiki prompt V2 workspace', () => {
    test('moves a new user block up repeatedly without duplicating keys', async () => {
        const props = $state({ preset: duplicateWikiPromptPreset(createDefaultWikiPromptPreset('official'), 'copy') })
        mounted = mount(RisuBardWikiPromptV2Workspace, { target: document.body, props })
        await tick()

        const addButton = [...document.body.querySelectorAll<HTMLButtonElement>('.add-actions button')]
            .find((button) => button.textContent?.includes(language.risuBardWikiPrompt.addBlock))!
        addButton.click()
        flushSync()
        const added = props.preset.blocks.find((block) => block.name === language.risuBardWikiPrompt.newBlock)!
        const startIndex = props.preset.blocks.indexOf(added)
        const moveUp = document.body.querySelector<HTMLButtonElement>(`.toolbar-buttons [title="${language.promptV2.moveUp}"]`)!

        for (let step = 1; step <= 3; step++) {
            moveUp.click()
            flushSync()
            expect(props.preset.blocks.findIndex((block) => block.id === added.id)).toBe(startIndex - step)
            expect(new Set(props.preset.blocks.map((block) => block.id)).size).toBe(props.preset.blocks.length)
        }
    })
})
