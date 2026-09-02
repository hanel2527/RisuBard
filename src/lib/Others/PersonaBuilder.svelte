<script lang="ts">
    import { onDestroy, tick } from 'svelte'
    import { LoaderCircleIcon, RotateCcwIcon, SendIcon, SparklesIcon, Undo2Icon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import { getModuleLorebooksWithSources } from 'src/ts/process/modules'
    import { requestChatData } from 'src/ts/process/request/request'
    import {
        DEFAULT_PERSONA_BUILDER_TASK_PROMPT,
        buildPersonaBuilderMessages,
        collectPersonaBuilderSources,
        matchPersonaBuilderCharacterLorebook,
        type PersonaBuilderSelections,
        type PersonaBuilderSourceSnapshot,
    } from 'src/ts/personaBuilder'
    import { getCurrentCharacter, type character } from 'src/ts/storage/database.svelte'
    import { DBState } from 'src/ts/stores.svelte'
    import PersonaPromptPresetEditor from './PersonaPromptPresetEditor.svelte'

    interface Props {
        open?: boolean
        personaName: string
        currentDescription: string
        onCopyDraft: (draft: string) => void | Promise<void>
    }

    let {
        open = $bindable(false),
        personaName,
        currentDescription,
        onCopyDraft,
    }: Props = $props()
    const copy = $derived(language.settingsWorkspace.personaManager.builder)

    let taskInstruction = $state(DEFAULT_PERSONA_BUILDER_TASK_PROMPT)
    let styleInstruction = $state('')
    let taskPresetId = $state('builtin:task-default')
    let stylePresetId = $state('')
    let userInstruction = $state('')
    let draft = $state('')
    let previousDraft = $state('')
    let canUndoDraft = $state(false)
    let sources = $state<PersonaBuilderSourceSnapshot>({
        systemPrompt: '',
        characterDescription: '',
        characterLorebook: '',
        moduleLorebook: '',
    })
    let selections = $state<PersonaBuilderSelections>({
        systemPrompt: true,
        characterDescription: true,
        characterLorebook: true,
        moduleLorebook: true,
    })
    let currentCharacter = $state<character | undefined>()
    let generating = $state(false)
    let error = $state('')
    let abortController: AbortController | null = null
    let wasOpen = false

    function abortRequest() {
        abortController?.abort()
        abortController = null
        generating = false
    }

    async function initializeBuilder(initialDraft = currentDescription) {
        abortRequest()
        currentCharacter = getCurrentCharacter() ?? undefined
        sources = collectPersonaBuilderSources({
            database: DBState.db,
            character: currentCharacter,
            moduleLorebooks: getModuleLorebooksWithSources(),
        })
        selections = {
            systemPrompt: !!sources.systemPrompt,
            characterDescription: !!sources.characterDescription,
            characterLorebook: !!sources.characterLorebook,
            moduleLorebook: !!sources.moduleLorebook,
        }
        taskInstruction = DEFAULT_PERSONA_BUILDER_TASK_PROMPT
        styleInstruction = ''
        taskPresetId = 'builtin:task-default'
        stylePresetId = ''
        userInstruction = ''
        draft = initialDraft
        previousDraft = ''
        canUndoDraft = false
        error = ''
        await tick()
        document.querySelector<HTMLTextAreaElement>('[data-persona-builder-instruction]')?.focus()
    }

    function resetBuilder() {
        void initializeBuilder('')
    }

    async function sendRequest() {
        if (generating) return
        error = ''
        const requestCharacter = currentCharacter
        const requestInput = {
            taskInstruction,
            styleInstruction,
            userInstruction,
            draft,
            selections: { ...selections },
            sources: { ...sources, characterLorebook: '' },
        }
        let formated
        try {
            formated = buildPersonaBuilderMessages(requestInput)
        }
        catch (cause) {
            error = cause instanceof Error && cause.message === 'persona-builder-task-required'
                ? copy.taskRequired
                : copy.instructionRequired
            return
        }

        const controller = new AbortController()
        abortController = controller
        generating = true
        try {
            if (requestInput.selections.characterLorebook) {
                const matched = await matchPersonaBuilderCharacterLorebook({
                    character: requestCharacter,
                    userInstruction: requestInput.userInstruction,
                    draft: requestInput.draft,
                })
                if (controller.signal.aborted) return
                requestInput.sources.characterLorebook = matched.content
                requestInput.sources.characterLorebookSources = matched.sources
                formated = buildPersonaBuilderMessages(requestInput)
            }
            const response = await requestChatData({
                formated,
                bias: {},
                currentChar: requestCharacter,
                useStreaming: false,
                noMultiGen: true,
                tools: [],
                disablePromptCache: true,
                logSource: 'other',
                logPurpose: 'persona-builder',
            }, 'model', controller.signal)
            if (controller.signal.aborted) return
            if (response.type !== 'success') {
                error = response.type === 'fail' && response.result.trim()
                    ? response.result.trim()
                    : copy.requestFailed
                return
            }
            const result = response.result.trim()
            if (!result) {
                error = copy.emptyResponse
                return
            }
            previousDraft = draft
            canUndoDraft = true
            draft = result
        }
        catch (cause) {
            if (!controller.signal.aborted) {
                error = cause instanceof Error && cause.message ? cause.message : copy.requestFailed
            }
        }
        finally {
            if (abortController === controller) {
                abortController = null
                generating = false
            }
        }
    }

    function undoDraft() {
        if (!canUndoDraft || generating) return
        draft = previousDraft
        previousDraft = ''
        canUndoDraft = false
        error = ''
    }

    async function copyDraft() {
        if (!draft.trim() || generating) return
        error = ''
        try {
            await onCopyDraft(draft.trim())
        }
        catch (cause) {
            error = cause instanceof Error && cause.message ? cause.message : copy.copyFailed
        }
    }

    $effect(() => {
        if (open && !wasOpen) void initializeBuilder()
        if (!open && wasOpen) abortRequest()
        wasOpen = open
    })

    onDestroy(abortRequest)
</script>

<ShDialog
    bind:open
    size="xl"
    tier="base"
    overlayClass="z-[45]"
    closeOnEscape={true}
    closeOnOutsideClick={false}
    contentClass="persona-builder-dialog z-[45]"
    bodyClass="min-h-0 overflow-y-auto"
    closeAriaLabel={copy.close}
>
    {#snippet title()}
        <span class="inline-flex items-center gap-2"><SparklesIcon size={19} />{copy.title}</span>
    {/snippet}
    {#snippet description()}{copy.description(personaName)}{/snippet}

    <div class="flex flex-col gap-4 pb-1">
        <div class="grid gap-2">
            <PersonaPromptPresetEditor kind="task" bind:value={taskInstruction} bind:selectedId={taskPresetId} />
            <PersonaPromptPresetEditor kind="style" bind:value={styleInstruction} bind:selectedId={stylePresetId} />
        </div>

        <fieldset data-persona-builder-context class="context-panel">
            <legend>{copy.contextTitle}</legend>
            <div class="grid gap-2 sm:grid-cols-2">
                <label class:unavailable={!sources.systemPrompt}>
                    <input type="checkbox" bind:checked={selections.systemPrompt} disabled={!sources.systemPrompt} />
                    <span>{copy.systemPrompt}{#if !sources.systemPrompt}<small>{copy.contextUnavailable}</small>{/if}</span>
                </label>
                <label class:unavailable={!sources.characterDescription}>
                    <input type="checkbox" bind:checked={selections.characterDescription} disabled={!sources.characterDescription} />
                    <span>{copy.characterDescription}{#if !sources.characterDescription}<small>{copy.contextUnavailable}</small>{/if}</span>
                </label>
                <label class:unavailable={!sources.characterLorebook}>
                    <input type="checkbox" bind:checked={selections.characterLorebook} disabled={!sources.characterLorebook} />
                    <span>{copy.characterLorebook}{#if !sources.characterLorebook}<small>{copy.contextUnavailable}</small>{/if}</span>
                </label>
                <label class:unavailable={!sources.moduleLorebook}>
                    <input type="checkbox" bind:checked={selections.moduleLorebook} disabled={!sources.moduleLorebook} />
                    <span>{copy.moduleLorebook}{#if !sources.moduleLorebook}<small>{copy.contextUnavailable}</small>{/if}</span>
                </label>
            </div>
            {#if !currentCharacter}
                <p>{copy.noCharacterContext}</p>
            {/if}
        </fieldset>

        <section class="builder-section">
            <label for="persona-builder-instruction">{copy.instructionLabel}</label>
            <div data-persona-builder-instruction-row class="instruction-row">
                <textarea
                    id="persona-builder-instruction"
                    data-persona-builder-instruction
                    class="builder-textarea instruction"
                    bind:value={userInstruction}
                    placeholder={copy.instructionPlaceholder}
                    disabled={generating}
                ></textarea>
                <div data-persona-builder-instruction-actions class="instruction-actions">
                    <ShButton
                        data-persona-builder-send
                        size="icon"
                        variant={generating ? 'destructive' : 'primary'}
                        disabled={generating}
                        aria-label={copy.send}
                        title={copy.send}
                        onclick={sendRequest}
                    >
                        {#if generating}
                            <LoaderCircleIcon class="animate-spin" size={17} />
                        {:else}
                            <SendIcon size={17} />
                        {/if}
                    </ShButton>
                    <ShButton
                        data-persona-builder-reset
                        size="icon"
                        variant="outline"
                        aria-label={copy.reset}
                        title={copy.reset}
                        onclick={resetBuilder}
                    ><RotateCcwIcon size={17} /></ShButton>
                </div>
            </div>
        </section>

        <section class="builder-section draft-section" aria-busy={generating}>
            <div class="draft-heading flex items-center justify-between gap-2">
                <label for="persona-builder-draft">{copy.draftTitle}</label>
                <div class="flex items-center gap-2">
                    {#if generating}<LoaderCircleIcon class="animate-spin text-textcolor2" size={17} />{/if}
                    <ShButton
                        data-persona-builder-undo
                        variant="outline"
                        size="sm"
                        disabled={!canUndoDraft || generating}
                        onclick={undoDraft}
                    ><Undo2Icon size={15} />{copy.undo}</ShButton>
                </div>
            </div>
            <textarea
                id="persona-builder-draft"
                data-persona-builder-draft
                class="builder-textarea draft"
                bind:value={draft}
                placeholder={copy.draftPlaceholder}
                disabled={generating}
            ></textarea>
        </section>

        {#if error}
            <p role="alert" class="error-message">{error}</p>
        {/if}

        <div class="flex justify-end border-t border-darkborderc pt-3">
            <ShButton variant="success" disabled={!draft.trim() || generating} onclick={copyDraft}>
                {copy.copyDraft}
            </ShButton>
        </div>
    </div>
</ShDialog>

<style>
    :global(.persona-builder-dialog) {
        height: 90vh;
        max-height: 90vh;
        background: var(--color-surface-base);
        overflow: hidden;
    }
    .context-panel,
    .builder-section {
        border: 1px solid var(--color-darkborderc);
        border-radius: .65rem;
        padding: .85rem;
        background: var(--color-surface-raised);
    }
    .context-panel legend,
    .builder-section > label,
    .builder-section label {
        color: var(--color-textcolor);
        font-size: .88rem;
        font-weight: 650;
    }
    .context-panel label {
        display: flex;
        align-items: center;
        gap: .55rem;
        min-height: 2.25rem;
        border-radius: .45rem;
        padding: .45rem .6rem;
        color: var(--color-textcolor);
        background: var(--color-surface-inset);
        cursor: pointer;
    }
    .context-panel label.unavailable {
        opacity: .42;
        cursor: not-allowed;
    }
    .context-panel input { accent-color: var(--color-primary); }
    .context-panel label span { display: flex; min-width: 0; flex-direction: column; }
    .context-panel label small { color: var(--color-textcolor2); font-size: .68rem; font-weight: 400; }
    .context-panel p { margin: .55rem 0 0; color: var(--color-textcolor2); font-size: .78rem; }
    .builder-section { display: flex; flex-direction: column; gap: .55rem; }
    .instruction-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: stretch; gap: .55rem; }
    .instruction-actions { display: flex; flex-direction: column; justify-content: space-between; gap: .55rem; }
    .builder-textarea {
        width: 100%;
        resize: vertical;
        border: 1px solid var(--color-darkborderc);
        border-radius: .55rem;
        padding: .75rem;
        color: var(--color-textcolor);
        background: var(--color-surface-inset);
        line-height: 1.55;
        outline: none;
    }
    .builder-textarea:focus {
        border-color: var(--color-borderc);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-borderc) 32%, transparent);
    }
    .builder-textarea.instruction { min-height: 7rem; }
    .builder-textarea.draft { min-height: 14rem; }
    .builder-textarea:disabled { opacity: .65; }
    .draft-section { min-height: 17rem; }
    .error-message {
        margin: 0;
        border: 1px solid color-mix(in srgb, var(--color-draculared) 55%, var(--color-darkborderc));
        border-radius: .55rem;
        padding: .7rem .8rem;
        color: var(--color-draculared);
        background: color-mix(in srgb, var(--color-draculared) 10%, var(--color-surface-base));
        font-size: .85rem;
    }
</style>
