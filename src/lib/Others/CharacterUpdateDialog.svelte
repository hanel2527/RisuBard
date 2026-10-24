<script lang="ts">
    import { RefreshCwIcon, ChevronRightIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShSelect from 'src/lib/UI/GUI/ShSelect.svelte'
    import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
    import { lineDiff } from 'src/ts/storage/externalChangeDiff'
    import { summarizePlan, type UpdateItem, type UpdateSide } from 'src/ts/characterUpdate'
    import { updateItemName, updateValueText } from 'src/ts/characterUpdateView'
    import {
        characterUpdateDialog as dialog, backToCharacterUpdateTargets, chooseAllCharacterUpdate, chooseCharacterUpdate,
        reviewCharacterUpdate, selectCharacterUpdateTarget, setCharacterUpdateChoice,
    } from 'src/ts/characterUpdateFlow.svelte'

    const text = $derived(language.characterUpdate)
    const request = $derived(dialog.request)
    const isModule = $derived(request?.kind === 'module')
    const plan = $derived(dialog.plan)
    const counts = $derived(plan ? summarizePlan(plan, dialog.choices) : null)
    const toDecide = $derived(plan ? plan.items.filter(item => item.choice === null) : [])
    const shown = $derived(plan ? (dialog.showAll ? plan.items : toDecide) : [])
    const otherValue = $derived(request?.others.some(other => other.id === dialog.target) ? dialog.target : '')
    let opened = $state<Record<string, boolean>>({})

    $effect(() => {
        // Open the first item that needs a decision.
        const first = dialog.plan?.items.find(item => item.choice === null)
        opened = first ? { [first.id]: true } : {}
    })

    function sideOf(item: UpdateItem): UpdateSide | null {
        return dialog.choices[item.id] ?? item.choice
    }

    function fieldLabel(field: string) {
        return text.fields[field] ?? field
    }

    function toggle(id: string) {
        opened = { ...opened, [id]: !opened[id] }
    }

    const summaryKeys = ['update', 'mine', 'added', 'removed', 'mineOnly', 'conflict', 'differs'] as const
</script>

{#snippet diffView(item: UpdateItem)}
    {@const before = updateValueText(item.mine)}
    {@const after = updateValueText(item.theirs)}
    <div class="diff" role="group" aria-label="{text.mineSide} → {text.theirsSide}">
        <div class="diff-legend">
            <span class="del">− {text.mineSide}</span>
            <span class="add">+ {text.theirsSide}</span>
        </div>
        {#if !before && !after}
            <p class="note pad">{text.absent}</p>
        {:else}
            <pre>{#each lineDiff(before, after) as line}{#if line.type === 'skip'}<span class="skip">⋯ {language.externalChangeSkipped(Number(line.text))}</span>{:else}<span class={line.type}>{line.type === 'add' ? '+ ' : line.type === 'del' ? '− ' : '  '}{line.text}</span>{/if}{/each}</pre>
        {/if}
    </div>
{/snippet}

<ShDialog
    open={!!request}
    size={dialog.step === 'review' ? 'xl' : 'lg'}
    tier="top"
    closable={false}
    closeOnOutsideClick={false}
    closeOnEscape={false}
    ariaLabel={text.title}
>
    {#snippet title()}
        <span class="title"><RefreshCwIcon size={20} />{dialog.step === 'review' ? text.reviewTitle(dialog.targetName) : isModule ? text.moduleTitle : text.title}</span>
    {/snippet}
    {#snippet description()}
        {#if request}
            {dialog.step === 'review' ? text.reviewDescription : isModule ? text.moduleDescription(request.incomingName) : text.description(request.incomingName)}
        {/if}
    {/snippet}

    {#if request && dialog.step === 'choose'}
        <div class="body">
            <h3>{isModule ? text.moduleCandidates : text.candidates}</h3>
            <div class="candidates" role="radiogroup" aria-label={text.candidates}>
                {#each request.candidates as candidate (candidate.id)}
                    <button
                        type="button"
                        role="radio"
                        aria-checked={dialog.target === candidate.id}
                        class="candidate"
                        class:selected={dialog.target === candidate.id}
                        disabled={dialog.busy}
                        onclick={() => selectCharacterUpdateTarget(candidate.id)}
                    >
                        <span class="dot" aria-hidden="true"></span>
                        <span class="candidate-main">
                            <strong>{candidate.name || text.unnamed}</strong>
                            <span class="meta">
                                <span class="badge {candidate.reason}">{isModule && candidate.reason === 'lineage' ? text.moduleLineage : text.reasons[candidate.reason]}</span>
                                {#if candidate.sameCreator && candidate.reason !== 'content'}<span class="badge">{text.sameCreator}</span>{/if}
                                <span>{isModule ? text.loreEntries(candidate.count) : text.chats(candidate.count)}</span>
                            </span>
                        </span>
                    </button>
                {/each}
            </div>
            {#if request.others.length}
                <label class="other">
                    <span>{isModule ? text.moduleOther : text.other}</span>
                    <ShSelect value={otherValue} ariaLabel={isModule ? text.moduleOther : text.other} onchange={(event) => { if (event.currentTarget.value) selectCharacterUpdateTarget(event.currentTarget.value) }}>
                        <OptionInput value="">{isModule ? text.moduleOtherPlaceholder : text.otherPlaceholder}</OptionInput>
                        {#each request.others as other (other.id)}
                            <OptionInput value={other.id}>{other.name || text.unnamed}</OptionInput>
                        {/each}
                    </ShSelect>
                </label>
            {/if}
            {#if dialog.error}<p class="note danger" role="alert">{dialog.error}</p>{/if}
        </div>
    {:else if request && plan && counts}
        <div class="body">
            {#if !plan.hasBase}<p class="notice">{text.noBase}</p>{/if}

            {#if plan.items.length}
                <ul class="summary">
                    {#each summaryKeys as key}
                        {#if counts[key]}<li class="chip {key}">{text.summary[key]} <b>{counts[key]}</b></li>{/if}
                    {/each}
                </ul>
            {:else}
                <p class="note">{isModule ? text.moduleNoChanges : text.noChanges}</p>
            {/if}

            {#if toDecide.length}
                <div class="decide-bar">
                    <strong class:done={counts.unresolved === 0}>{text.decideCount(counts.unresolved)}</strong>
                    <span class="bulk">
                        <ShButton size="sm" variant="outline" onclick={() => chooseAllCharacterUpdate('mine')}>{text.allMine}</ShButton>
                        <ShButton size="sm" variant="outline" onclick={() => chooseAllCharacterUpdate('theirs')}>{text.allTheirs}</ShButton>
                    </span>
                </div>
            {:else if plan.items.length}
                <p class="note">{text.nothingToDecide}</p>
            {/if}

            {#if shown.length}
                <ul class="items">
                    {#each shown as item (item.id)}
                        {@const side = sideOf(item)}
                        {@const name = updateItemName(item)}
                        <li class="item" class:pending={!side}>
                            <div class="item-row">
                                <button type="button" class="item-head" aria-expanded={!!opened[item.id]} onclick={() => toggle(item.id)}>
                                    <ChevronRightIcon size={14} class="chevron {opened[item.id] ? 'open' : ''}" />
                                    <span class="field">{fieldLabel(item.field)}</span>
                                    {#if item.key}<span class="item-name">{name || text.unnamed}</span>{/if}
                                    <span class="status {item.status}">{text.status[item.status]}</span>
                                </button>
                                <span class="choice" role="radiogroup" aria-label={fieldLabel(item.field)}>
                                    <button type="button" role="radio" aria-checked={side === 'mine'} class:on={side === 'mine'} onclick={() => setCharacterUpdateChoice(item.id, 'mine')}>{text.keepMine}</button>
                                    <button type="button" role="radio" aria-checked={side === 'theirs'} class:on={side === 'theirs'} onclick={() => setCharacterUpdateChoice(item.id, 'theirs')}>{text.takeTheirs}</button>
                                </span>
                            </div>
                            {#if opened[item.id]}{@render diffView(item)}{/if}
                        </li>
                    {/each}
                </ul>
            {/if}

            {#if plan.items.length > toDecide.length}
                <button type="button" class="link" onclick={() => { dialog.showAll = !dialog.showAll }}>
                    {dialog.showAll ? text.hideAll : text.showAll(plan.items.length)}
                </button>
            {/if}

            <p class="note foot">{isModule ? text.moduleBackupNote : text.backupNote}</p>
            {#if dialog.targetBusy}<p class="note danger" role="alert">{text.busy}</p>{/if}
            {#if dialog.error}<p class="note danger" role="alert">{dialog.error}</p>{/if}
        </div>
    {/if}

    {#snippet footer()}
        {#if dialog.step === 'choose'}
            <ShButton variant="ghost" disabled={dialog.busy} onclick={() => chooseCharacterUpdate('cancel')}>{text.cancel}</ShButton>
            <ShButton variant="outline" disabled={dialog.busy} onclick={() => chooseCharacterUpdate('new')}>{isModule ? text.installNewModule : text.installNew}</ShButton>
            <ShButton variant="primary" disabled={dialog.busy || !dialog.target} onclick={() => reviewCharacterUpdate()}>{text.next}</ShButton>
        {:else}
            <!-- No "install as new" here: it would sit where "Next" was, so a double click would pick it. -->
            <ShButton variant="outline" onclick={() => backToCharacterUpdateTargets()}>{text.back}</ShButton>
            <ShButton variant="primary" disabled={!counts || counts.unresolved > 0 || dialog.targetBusy} onclick={() => chooseCharacterUpdate('update')}>{text.update}</ShButton>
        {/if}
    {/snippet}
</ShDialog>

<style>
    .title { display: inline-flex; align-items: center; gap: .5rem; }
    .title :global(svg) { color: var(--color-primary); flex: 0 0 auto; }
    .body { display: grid; gap: .75rem; min-width: 0; }
    h3 { margin: 0; font-size: .8rem; font-weight: 600; color: var(--color-textcolor2); }
    .candidates { display: grid; gap: .4rem; }
    .candidate { display: flex; align-items: center; gap: .7rem; width: 100%; padding: .65rem .8rem; border: 1px solid var(--color-darkborderc); border-radius: .65rem; text-align: left; color: var(--color-textcolor); background: color-mix(in srgb, var(--color-darkbutton) 35%, transparent); }
    .candidate:hover { border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-darkborderc)); }
    .candidate.selected { border-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 12%, transparent); }
    .dot { flex: 0 0 auto; width: 1rem; height: 1rem; border-radius: 999px; border: 2px solid var(--color-textcolor2); }
    .candidate.selected .dot { border-color: var(--color-primary); box-shadow: inset 0 0 0 3px var(--color-bgcolor, transparent); background: var(--color-primary); }
    .candidate-main { display: grid; gap: .25rem; min-width: 0; }
    .candidate-main strong { font-size: .98rem; overflow-wrap: anywhere; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; font-size: .78rem; color: var(--color-textcolor2); }
    .badge { padding: .08rem .45rem; border-radius: 999px; border: 1px solid var(--color-darkborderc); }
    .badge.realm, .badge.lineage { color: var(--color-success); border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-darkborderc)); }
    .other { display: grid; gap: .35rem; font-size: .8rem; font-weight: 600; color: var(--color-textcolor2); }
    .notice { margin: 0; padding: .6rem .8rem; border-radius: .6rem; font-size: .85rem; line-height: 1.55; color: var(--color-textcolor); border: 1px solid color-mix(in srgb, var(--color-warning, var(--color-primary)) 45%, var(--color-darkborderc)); background: color-mix(in srgb, var(--color-warning, var(--color-primary)) 10%, transparent); }
    .summary { display: flex; flex-wrap: wrap; gap: .4rem; margin: 0; padding: 0; list-style: none; }
    .chip { padding: .2rem .6rem; border-radius: 999px; font-size: .8rem; color: var(--color-textcolor2); border: 1px solid var(--color-darkborderc); }
    .chip b { color: var(--color-textcolor); margin-left: .15rem; }
    .chip.conflict, .chip.differs { color: var(--color-warning, var(--color-danger)); border-color: color-mix(in srgb, var(--color-warning, var(--color-danger)) 45%, var(--color-darkborderc)); }
    .decide-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem; }
    .decide-bar strong { font-size: .92rem; color: var(--color-warning, var(--color-danger)); }
    .decide-bar strong.done { color: var(--color-success); }
    .bulk { display: inline-flex; gap: .4rem; }
    .items { display: grid; gap: .35rem; margin: 0; padding: 0; list-style: none; }
    .item { border: 1px solid var(--color-darkborderc); border-radius: .6rem; padding: .25rem .35rem; min-width: 0; }
    .item.pending { border-color: color-mix(in srgb, var(--color-warning, var(--color-danger)) 55%, var(--color-darkborderc)); }
    .item-row { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; }
    .item-head { flex: 1 1 14rem; display: flex; align-items: center; gap: .4rem; min-width: 0; min-height: 2.25rem; padding: .2rem .35rem; border-radius: .4rem; color: var(--color-textcolor); text-align: left; font-size: .88rem; }
    .item-head:hover { background: color-mix(in srgb, var(--color-selected) 35%, transparent); }
    .item-head :global(.chevron) { flex: 0 0 auto; transition: transform .15s ease; color: var(--color-textcolor2); }
    .item-head :global(.chevron.open) { transform: rotate(90deg); }
    .field { flex: 0 0 auto; font-weight: 600; }
    .item-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-textcolor); }
    .status { flex: 0 0 auto; margin-left: auto; font-size: .74rem; color: var(--color-textcolor2); }
    .status.conflict, .status.differs { color: var(--color-warning, var(--color-danger)); }
    .status.added, .status.update { color: var(--color-success); }
    .status.removed { color: var(--color-danger); }
    .choice { display: inline-flex; flex: 0 0 auto; border: 1px solid var(--color-darkborderc); border-radius: .5rem; overflow: hidden; }
    .choice button { min-height: 2.25rem; padding: .2rem .7rem; font-size: .8rem; color: var(--color-textcolor2); }
    .choice button + button { border-left: 1px solid var(--color-darkborderc); }
    .choice button:hover { color: var(--color-textcolor); background: color-mix(in srgb, var(--color-selected) 35%, transparent); }
    .choice button.on { color: var(--color-textcolor); background: color-mix(in srgb, var(--color-primary) 22%, transparent); font-weight: 600; }
    .diff { margin: .25rem .2rem .35rem 1.3rem; border: 1px solid var(--color-darkborderc); border-radius: .5rem; overflow: hidden; }
    .diff-legend { display: flex; gap: 1rem; padding: .3rem .6rem; font-size: .72rem; border-bottom: 1px solid var(--color-darkborderc); color: var(--color-textcolor2); }
    pre { margin: 0; max-height: 18rem; overflow: auto; padding: .4rem 0; font-size: .78rem; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    pre span { display: block; padding: 0 .6rem; }
    .add { color: var(--color-success); }
    pre .add { background: color-mix(in srgb, var(--color-success) 12%, transparent); }
    .del { color: var(--color-danger); }
    pre .del { background: color-mix(in srgb, var(--color-danger) 12%, transparent); }
    pre .same { color: var(--color-textcolor2); }
    pre .skip { color: var(--color-textcolor2); font-style: italic; opacity: .75; }
    .link { justify-self: start; font-size: .82rem; color: var(--color-primary); text-decoration: underline; text-underline-offset: 3px; }
    .note { margin: 0; color: var(--color-textcolor2); font-size: .85rem; line-height: 1.5; }
    .note.pad { padding: .5rem .6rem; }
    .note.foot { padding-top: .5rem; border-top: 1px solid var(--color-darkborderc); font-size: .8rem; }
    .note.danger { color: var(--color-danger); }
</style>
