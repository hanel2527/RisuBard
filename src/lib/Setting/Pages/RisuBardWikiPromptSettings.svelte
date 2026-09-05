<script lang="ts">
    import {
        CopyIcon,
        DownloadIcon,
        PlusIcon,
        Trash2Icon,
        UploadIcon,
    } from '@lucide/svelte'
    import { v4 as uuidv4 } from 'uuid'
    import { language } from 'src/lang'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import { downloadFile } from 'src/ts/globalApi.svelte'
    import {
        createDefaultWikiPromptPreset,
        deleteWikiPromptPreset,
        duplicateWikiPromptPreset,
        parseWikiPromptPreset,
        resolveWikiPromptPreset,
        serializeWikiPromptPreset,
        type WikiPromptBlock,
        type WikiPromptPreset,
    } from 'src/ts/risubard/wikiPromptPreset'
    import { DBState } from 'src/ts/stores.svelte'
    import { selectSingleFile } from 'src/ts/util'
    import PresetHeader from 'src/lib/UI/GUI/PresetHeader.svelte'
    import SettingPage from 'src/lib/UI/GUI/SettingPage.svelte'
    import SettingTabs from 'src/lib/UI/GUI/SettingTabs.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import RisuBardWikiPromptBlock from './RisuBardWikiPromptBlock.svelte'
    import RisuBardWikiPromptReferenceSheet from './RisuBardWikiPromptReferenceSheet.svelte'

    let activeTab = $state(0)
    let choosingPreset = $state(false)
    let promptingHelpOpen = $state(false)

    let activePresetId = $derived(DBState.db.risuBardChatWikiPromptPresetId)
    let activePreset = $derived(resolveWikiPromptPreset(
        DBState.db.risuBardWikiPromptPresets,
        activePresetId
    ))

    function selectPreset(presetId: string) {
        DBState.db.risuBardChatWikiPromptPresetId = presetId
        choosingPreset = false
    }

    function touchPreset(preset: WikiPromptPreset) {
        preset.revision = Math.min(2_147_483_647, preset.revision + 1)
    }

    function addBlock(target: 'both' | 'response' = 'both') {
        if (!activePreset) return
        const block: WikiPromptBlock = {
            id: uuidv4(),
            type: 'text',
            name: language.risuBardWikiPrompt.newBlock,
            target,
            enabled: true,
            readonly: false,
            content: '',
        }
        const injectionAt = activePreset.blocks.findIndex((item) =>
            item.id === 'character-wiki-guide'
        )
        activePreset.blocks.splice(injectionAt < 0
            ? activePreset.blocks.length
            : injectionAt, 0, block)
        touchPreset(activePreset)
    }

    function editableIndices(response: boolean): number[] {
        return activePreset?.blocks.flatMap((block, index) =>
            block.type === 'text' && (block.target === 'response') === response
                ? [index]
                : []
        ) ?? []
    }

    function moveEditableBlock(index: number, direction: -1 | 1) {
        if (!activePreset) return
        const positions = editableIndices(
            activePreset.blocks[index]?.target === 'response'
        )
        const current = positions.indexOf(index)
        const destination = positions[current + direction]
        if (current < 0 || destination === undefined) return
        const blocks = activePreset.blocks
        ;[blocks[index], blocks[destination]] = [blocks[destination], blocks[index]]
        touchPreset(activePreset)
    }

    function removeBlock(index: number) {
        if (!activePreset
            || activePreset.blocks[index]?.readonly
            || activePreset.blocks[index]?.id === 'main-wiki-guide') return
        activePreset.blocks.splice(index, 1)
        touchPreset(activePreset)
    }

    function createPreset() {
        const preset = createDefaultWikiPromptPreset(uuidv4())
        preset.name = language.risuBardWikiPrompt.newPresetName
        DBState.db.risuBardWikiPromptPresets ??= []
        DBState.db.risuBardWikiPromptPresets.push(preset)
        selectPreset(preset.id)
        notifySuccess(language.risuBardWikiPrompt.presetCreated)
    }

    function duplicateActivePreset() {
        if (!activePreset) return
        const duplicate = duplicateWikiPromptPreset(activePreset, uuidv4())
        DBState.db.risuBardWikiPromptPresets ??= []
        DBState.db.risuBardWikiPromptPresets.push(duplicate)
        selectPreset(duplicate.id)
        notifySuccess(language.presetDuplicated)
    }

    async function exportActivePreset() {
        if (!activePreset) return
        const filename = `${activePreset.name.replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'wiki-prompt'}.bardwiki-prompt.json`
        await downloadFile(
            filename,
            new TextEncoder().encode(serializeWikiPromptPreset(activePreset))
        )
        notifySuccess(language.presetExported)
    }

    async function importPreset() {
        try {
            const file = await selectSingleFile(['json'])
            if (!file) return
            const preset = parseWikiPromptPreset(
                new TextDecoder().decode(file.data),
                uuidv4
            )
            DBState.db.risuBardWikiPromptPresets ??= []
            DBState.db.risuBardWikiPromptPresets.push(preset)
            selectPreset(preset.id)
            notifySuccess(language.presetImported)
        }
        catch (error) {
            notifyError(error instanceof Error ? error.message : String(error))
        }
    }

    async function deleteActivePreset() {
        if (!activePreset) return
        const ok = await alertConfirm(
            `${language.presetDeleteConfirm}\n${activePreset.name}`
        )
        if (!ok) return
        const result = deleteWikiPromptPreset(
            DBState.db.risuBardWikiPromptPresets ?? [],
            activePreset.id
        )
        if (!result.deleted) {
            notifyError(language.errors.onlyOnePreset)
            return
        }
        DBState.db.risuBardWikiPromptPresets = result.presets
        const fallback = result.presets[0].id
        if (DBState.db.risuBardChatWikiPromptPresetId === activePreset.id) {
            DBState.db.risuBardChatWikiPromptPresetId = fallback
        }
        notifySuccess(language.presetDeleted)
    }

    function blockDisplayName(block: WikiPromptBlock): string {
        return language.risuBardWikiPrompt.blockNames[block.id as keyof typeof language.risuBardWikiPrompt.blockNames]
            ?? block.name
    }
</script>

<SettingPage
    title={language.risuBardWikiPrompt.title}
    description={language.risuBardWikiPrompt.description}
>
    <PresetHeader
        label={language.risuBardWikiPrompt.activePreset}
        activeName={activePreset?.name ?? '—'}
        onManage={() => { choosingPreset = !choosingPreset }}
    />

    {#if choosingPreset}
        <div class="preset-picker">
            {#each DBState.db.risuBardWikiPromptPresets ?? [] as preset (preset.id)}
                <button
                    class:selected={preset.id === activePreset?.id}
                    onclick={() => selectPreset(preset.id)}
                >
                    <span>{preset.name}</span>
                    {#if preset.id === activePreset?.id}<small>{language.risuBardWikiPrompt.current}</small>{/if}
                </button>
            {/each}
        </div>
    {/if}

    <SettingTabs
        tabs={[
            { label: language.prompt, value: 0 },
            { label: language.basicInfo, value: 1 },
        ]}
        bind:selected={activeTab}
        variant="prominent"
    />

    {#if activePreset && activeTab === 0}
        <section class="prompt-section">
            <div class="section-heading">
                <h3>{language.risuBardWikiPrompt.writingSection}</h3>
                <p>{language.risuBardWikiPrompt.writingSectionDescription}</p>
            </div>
            <div class="block-list">
                {#each activePreset.blocks as block, index (block.id)}
                    {#if block.target !== 'response'}
                        <RisuBardWikiPromptBlock
                            bind:block={activePreset.blocks[index]}
                            displayName={blockDisplayName(block)}
                            moveUp={() => moveEditableBlock(index, -1)}
                            moveDown={() => moveEditableBlock(index, 1)}
                            onRemove={() => removeBlock(index)}
                            onHelp={() => { promptingHelpOpen = true }}
                        />
                    {/if}
                {/each}
            </div>
            <ShButton variant="outline" className="w-full" onclick={() => addBlock('both')}>
                <PlusIcon size={16} />
                {language.risuBardWikiPrompt.addBlock}
            </ShButton>
        </section>

        <section class="prompt-section">
            <div class="section-heading">
                <h3>{language.risuBardWikiPrompt.responseSection}</h3>
                <p>{language.risuBardWikiPrompt.responseSectionDescription}</p>
            </div>
            <div class="block-list response-list">
                {#each activePreset.blocks as block, index (block.id)}
                    {#if block.target === 'response'}
                        <RisuBardWikiPromptBlock
                            bind:block={activePreset.blocks[index]}
                            displayName={blockDisplayName(block)}
                            moveUp={() => moveEditableBlock(index, -1)}
                            moveDown={() => moveEditableBlock(index, 1)}
                            onRemove={() => removeBlock(index)}
                            onHelp={() => { promptingHelpOpen = true }}
                        />
                    {/if}
                {/each}
            </div>
            <ShButton variant="outline" className="w-full" onclick={() => addBlock('response')}>
                <PlusIcon size={16} />
                {language.risuBardWikiPrompt.addResponseBlock}
            </ShButton>
        </section>
    {:else if activePreset}
        <div class="basic-panel">
            <label>
                <span>{language.name}</span>
                <TextInput bind:value={activePreset.name} fullwidth />
            </label>
            <div class="file-actions">
                <ShButton variant="default" onclick={createPreset}>
                    <PlusIcon size={16} />{language.risuBardWikiPrompt.createPreset}
                </ShButton>
                <ShButton variant="default" onclick={duplicateActivePreset}>
                    <CopyIcon size={16} />{language.presetDuplicate}
                </ShButton>
                <ShButton variant="default" onclick={exportActivePreset}>
                    <DownloadIcon size={16} />{language.presetExport}
                </ShButton>
                <ShButton variant="default" onclick={importPreset}>
                    <UploadIcon size={16} />{language.presetImport}
                </ShButton>
                <ShButton variant="destructive" onclick={deleteActivePreset}>
                    <Trash2Icon size={16} />{language.presetDelete}
                </ShButton>
            </div>
        </div>
    {/if}

    <RisuBardWikiPromptReferenceSheet bind:open={promptingHelpOpen} />
</SettingPage>

<style>
    .preset-picker,
    .block-list,
    .basic-panel {
        overflow: hidden;
        margin: -.65rem 0 1rem;
        border: 1px solid var(--settings-border, var(--risu-theme-darkborderc));
        border-radius: var(--settings-radius, .75rem);
        background: var(--settings-surface, var(--risu-theme-bgcolor));
    }

    .preset-picker button {
        display: flex;
        width: 100%;
        align-items: center;
        justify-content: space-between;
        padding: .75rem 1rem;
        border-top: 1px solid var(--settings-border, var(--risu-theme-darkborderc));
        text-align: left;
    }

    .preset-picker button:first-child {
        border-top: 0;
    }

    .preset-picker button.selected {
        background: var(--risu-theme-selected);
    }

    .preset-picker small {
        color: var(--risu-theme-textcolor2);
    }

    .block-list {
        margin-top: 1rem;
    }

    .prompt-section {
        display: grid;
        gap: .75rem;
        margin-top: 1.2rem;
    }

    .section-heading {
        display: grid;
        gap: .25rem;
        padding: 0 .15rem;
    }

    .section-heading h3,
    .section-heading p {
        margin: 0;
    }

    .section-heading h3 {
        font-size: .95rem;
        font-weight: 700;
    }

    .section-heading p {
        color: var(--risu-theme-textcolor2);
        font-size: .78rem;
        line-height: 1.5;
    }

    .prompt-section .block-list {
        margin: 0;
    }

    .basic-panel {
        margin-top: 1rem;
        padding: 1rem;
    }

    .basic-panel label {
        display: grid;
        gap: .45rem;
    }

    .file-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: .55rem;
        margin-top: 1rem;
    }

    @media (max-width: 560px) {
        .file-actions {
            grid-template-columns: 1fr;
        }
    }
</style>
