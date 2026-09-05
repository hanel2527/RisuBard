import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = process.cwd()

function source(path: string) {
    return readFileSync(resolve(root, path), 'utf8')
}

describe('inline collection organizer list', () => {
    test('renders organization and parent item actions in the default list instead of a dialog', () => {
        const component = source('src/lib/UI/CollectionOrganizerList.svelte')

        expect(component).not.toContain('ShDialog')
        expect(component).toContain("import type { Snippet }")
        expect(component).toContain('itemContent')
        expect(component).toContain('{@render itemContent(item.id)}')
        expect(component).toContain('data-collection-splitter')
        expect(component).toContain('container-type: inline-size')
        expect(component).toContain('@container collection-manager (min-width: 720px)')
    })

    test('keeps folder deletion, immediate persistence, bulk movement, and accessible reorder controls inline', () => {
        const component = source('src/lib/UI/CollectionOrganizerList.svelte')

        expect(component).toContain('deleteCollectionFolder')
        expect(component).toContain('requestImmediateSave')
        expect(component).toContain('assignItemsToFolder')
        expect(component).toContain('moveFolderUp')
        expect(component).toContain('moveItemDown')
        expect(component).toContain('GripVerticalIcon')
        expect(component).toContain('data-collection-drag-handle')
        expect(component).toContain('selectedItemIds.filter((id) => itemIds.includes(id))')
    })

    test('prompt presets render their native actions inside the inline organizer', () => {
        const page = source('src/lib/Setting/botpreset.svelte')

        expect(page).toContain('CollectionOrganizerList')
        expect(page).toContain('{#snippet itemContent(presetId)}')
        expect(page).toContain('copyPreset(i)')
        expect(page).toContain("downloadPreset(i, 'risupreset')")
        expect(page).toContain('assignPresetToFolder')
        expect(page).not.toContain('CollectionOrganizerDialog')
        expect(page).not.toContain('organizerOpen')
    })

    test('modules keep export in the editor while rendering enable, persona, edit, and delete actions inline', () => {
        const page = source('src/lib/Setting/Pages/Module/ModuleSettings.svelte')

        expect(page).toContain('CollectionOrganizerList')
        expect(page).toContain('{#snippet itemContent(moduleId)}')
        expect(page).toContain('openPersonaAssignments(rmodule.id)')
        expect(page).not.toContain('exportModule(rmodule)')
        expect(page).toContain('exportModule(tempModule)')
        expect(page).toContain('assignModuleToFolder')
        expect(page).not.toContain('CollectionOrganizerDialog')
        expect(page).not.toContain('organizerOpen')
    })

    test('plugins render native update, toggle, permission, arguments, and delete actions inline', () => {
        const page = source('src/lib/Setting/Pages/PluginSettings.svelte')

        expect(page).toContain('CollectionOrganizerList')
        expect(page).toContain('{#snippet itemContent(pluginName)}')
        expect(page).toContain('await updatePlugin(plugin)')
        expect(page).toContain('notifyError(language.pluginUpdateFailed)')
        expect(page).toContain('assignPluginToFolder')
        expect(page).not.toContain('CollectionOrganizerDialog')
        expect(page).not.toContain('organizerOpen')
    })
})
