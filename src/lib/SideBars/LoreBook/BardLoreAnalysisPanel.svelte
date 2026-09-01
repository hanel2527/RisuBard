<script lang="ts">
    import { onDestroy, untrack } from 'svelte'
    import { v4 as createUuid } from 'uuid'
    import { language } from 'src/lang'
    import { DBState } from 'src/ts/stores.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import {
        createBardLoreSettings,
        fingerprintBardLoreEntry,
        type BardLoreAnalysisRun,
        type BardLoreAnalysisScope,
        type BardLoreEntry,
        type BardLoreSettings,
    } from 'src/ts/lorebook/bardLore'
    import {
        applyBardLoreAnalysisDraft,
        auditBardLoreAnalysisDraft,
        auditBardLoreMetadata,
        bardLoreAtomicAnalysisSchema,
        bardLoreAnalysisDraftFromRun,
        bardLoreAnalysisSchema,
        buildBardLoreAtomicRetryPrompt,
        buildBardLoreAnalysisPrompt,
        buildBardLoreAnalysisQualityRepairPrompt,
        collectBardLoreAnalysisTargets,
        completeBardLoreAnalysisBatch,
        createBardLoreAnalysisRun,
        failBardLoreAnalysisBatch,
        finishBardLoreAnalysisRun,
        isBardLoreCompositeEntry,
        parseBardLoreAnalysisResponse,
        pauseBardLoreAnalysisRun,
        planBardLoreAnalysisBatches,
        retryFailedBardLoreAnalysisBatches,
        startBardLoreAnalysisBatch,
        type BardLoreAnalysisPlan,
        type BardLoreAnalysisQualityIssue,
    } from 'src/ts/lorebook/bardLoreAnalysis'
    import {
        resolveBardLoreAnalysisLanguage,
        type ResolvedBardLoreAnalysisLanguage,
    } from 'src/ts/lorebook/bardLoreLanguage'

    interface Props {
        entries: BardLoreEntry[]
        settings: BardLoreSettings
        activeEntryId?: string | null
        analysisRun?: BardLoreAnalysisRun
        compact?: boolean
        onChange: (entries: BardLoreEntry[]) => void
        onSettingsChange?: (settings: BardLoreSettings) => void
        onAnalysisRunChange?: (run: BardLoreAnalysisRun | undefined) => void
    }

    let {
        entries,
        settings,
        activeEntryId,
        analysisRun,
        compact = false,
        onChange,
        onSettingsChange = () => {},
        onAnalysisRunChange = () => {},
    }: Props = $props()
    let open = $state(false)
    let scope = $state<BardLoreAnalysisScope>('all')
    let planning = $state(false)
    let analyzing = $state(false)
    let qualityRepair = $state(false)
    let error = $state('')
    let conflicts = $state<Array<{ id: string; reason: string }>>([])
    let plan = $state<BardLoreAnalysisPlan | null>(null)
    let plannedTargets = $state<BardLoreEntry[]>([])
    let plannedLanguage = $state<ResolvedBardLoreAnalysisLanguage>('ko')
    let currentRun = $state<BardLoreAnalysisRun | undefined>()
    let workingSettings = $state(createBardLoreSettings())
    let controller: AbortController | undefined
    let lastExternalRun: BardLoreAnalysisRun | undefined
    let lastExternalSettings: BardLoreSettings | undefined
    let replanSequence = 0

    const eligibleEntries = $derived(entries.filter((entry) => entry.mode !== 'folder' && entry.mode !== 'child'))
    const untypedCount = $derived(eligibleEntries.filter((entry) => entry.bard.kind === 'other').length)
    const missingSummaryCount = $derived(eligibleEntries.filter((entry) => !entry.bard.summary.trim()).length)
    const missingTagsCount = $derived(eligibleEntries.filter((entry) => entry.bard.tags.length === 0).length)
    const qualityAudit = $derived(auditBardLoreMetadata(entries, settings))
    const completeCount = $derived(currentRun?.batches.filter((batch) => batch.status === 'complete').length ?? 0)
    const failedCount = $derived(currentRun?.batches.filter((batch) => batch.status === 'failed').length ?? 0)
    const pendingCount = $derived(currentRun?.batches.filter((batch) => batch.status === 'pending').length ?? 0)
    const candidateCount = $derived(currentRun ? bardLoreAnalysisDraftFromRun(currentRun).entries.length : 0)
    const processedEntries = $derived(currentRun?.batches
        .filter((batch) => batch.status === 'complete')
        .reduce((sum, batch) => sum + batch.targetIds.length, 0) ?? 0)

    $effect(() => {
        const next = analysisRun
        if (next === lastExternalRun) return
        lastExternalRun = next
        if (!untrack(() => analyzing)) currentRun = next
    })
    $effect(() => {
        const next = settings
        if (next === lastExternalSettings) return
        lastExternalSettings = next
        workingSettings = createBardLoreSettings(next)
    })
    $effect(() => {
        if (!open && !currentRun) scope = activeEntryId ? 'entry' : 'all'
    })

    function saveRun(next: BardLoreAnalysisRun | undefined) {
        currentRun = next
        onAnalysisRunChange(next)
    }

    async function prepareTargets(targets: BardLoreEntry[], runtimeSettings = workingSettings) {
        error = ''
        conflicts = []
        plan = null
        runtimeSettings = createBardLoreSettings(runtimeSettings)
        if (targets.length === 0) {
            error = language.lorebookWorkspace.bardAnalysisNoTargets
            return
        }
        planning = true
        try {
            const { tokenize } = await import('src/ts/tokenizer')
            const analysisLanguage = resolveBardLoreAnalysisLanguage(
                DBState.db.risuBardGrimoireLanguage,
                DBState.db.risuBardWikiWritingLanguage === 'en' ? 'en' : 'ko',
            )
            plannedTargets = targets
            plannedLanguage = analysisLanguage
            plan = await planBardLoreAnalysisBatches(
                targets,
                entries,
                runtimeSettings,
                tokenize,
                analysisLanguage,
                'ko',
            )
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            planning = false
        }
    }

    async function prepare(runtimeSettings = workingSettings) {
        qualityRepair = false
        const normalizedSettings = createBardLoreSettings(runtimeSettings)
        const targets = collectBardLoreAnalysisTargets(
            entries,
            scope,
            activeEntryId ?? undefined,
            normalizedSettings.analysisLinkedDepth,
        )
        await prepareTargets(targets, normalizedSettings)
    }

    function openWorkbench() {
        open = true
        if (!currentRun) void prepare()
    }

    function openQualityRepair() {
        if (currentRun || qualityAudit.failedEntryIds.length === 0) return
        const failed = new Set(qualityAudit.failedEntryIds)
        const targets = eligibleEntries.filter((entry) => failed.has(entry.id))
        qualityRepair = true
        open = true
        void prepareTargets(targets)
    }

    type AnalysisSettingKey =
        | 'analysisBatchEntries'
        | 'analysisInputTokens'
        | 'analysisOutputTokens'
        | 'analysisLinkedDepth'
        | 'analysisTemperature'

    function updateAnalysisSetting(key: AnalysisSettingKey, raw: string) {
        const value = Number(raw)
        if (!Number.isFinite(value)) return
        const next = createBardLoreSettings({ ...workingSettings, [key]: value })
        workingSettings = next
        onSettingsChange(next)
        if (currentRun) void replanCurrentRun(next)
        else void prepare(next)
    }

    async function replanCurrentRun(runtimeSettings: BardLoreSettings) {
        if (!currentRun || analyzing) return
        const sequence = ++replanSequence
        const run = currentRun
        const completed = run.batches.filter((batch) => batch.status === 'complete')
        const completedIds = new Set(completed.flatMap((batch) => batch.targetIds))
        const remainingIds = run.targetIds.filter((id) => !completedIds.has(id))
        if (remainingIds.length === 0) {
            saveRun({ ...run, settingsSnapshot: runtimeSettings, updatedAt: new Date().toISOString() })
            return
        }
        const byId = new Map(entries.map((entry) => [entry.id, entry]))
        const remaining = remainingIds.map((id) => byId.get(id)).filter((entry): entry is BardLoreEntry => Boolean(entry))
        planning = true
        error = ''
        try {
            if (remaining.length !== remainingIds.length) throw new Error(language.lorebookWorkspace.bardAnalysisMissingEntry)
            const { tokenize } = await import('src/ts/tokenizer')
            const replanned = await planBardLoreAnalysisBatches(
                remaining,
                entries,
                runtimeSettings,
                tokenize,
                run.languageSnapshot ?? 'bilingual',
                'ko',
            )
            if (sequence !== replanSequence) return
            const rebuilt = replanned.batches.map((batch) => ({
                id: createUuid(),
                index: 0,
                targetIds: batch.entries.map((entry) => entry.id),
                estimatedInputTokens: batch.inputTokens,
                status: 'pending' as const,
            }))
            const batches = [...completed, ...rebuilt].map((batch, index) => ({ ...batch, index }))
            saveRun({
                ...run,
                settingsSnapshot: runtimeSettings,
                batches,
                status: rebuilt.length > 0 ? 'paused' : 'review',
                updatedAt: new Date().toISOString(),
            })
        }
        catch (cause) {
            if (sequence === replanSequence) error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            if (sequence === replanSequence) planning = false
        }
    }

    function batchNumberForTarget(id: string): number {
        const batches = currentRun?.batches ?? plan?.batches
        if (!batches) return 0
        return batches.findIndex((batch) => currentRun
            ? batch.targetIds.includes(id)
            : batch.entries.some((entry) => entry.id === id)) + 1
    }

    function displayRunTargets(): BardLoreEntry[] {
        if (!currentRun) return []
        const ids = new Set(currentRun.targetIds)
        return entries.filter((entry) => ids.has(entry.id))
    }

    function validationErrorLabel(value: string | undefined): string {
        if (!value) return language.lorebookWorkspace.bardAnalysisErrorUnknown
        if (value === 'bard-lore-analysis-invalid') {
            return language.lorebookWorkspace.bardAnalysisErrorLegacyInvalid
        }
        if (value.startsWith('bard-lore-analysis-quality:')) {
            return language.lorebookWorkspace.bardAnalysisErrorQuality
        }
        const reason = value.startsWith('bard-lore-analysis-invalid:')
            ? value.slice('bard-lore-analysis-invalid:'.length)
            : ''
        const labels: Record<string, string> = {
            'invalid-json': language.lorebookWorkspace.bardAnalysisErrorInvalidJson,
            'missing-entries': language.lorebookWorkspace.bardAnalysisErrorMissingEntries,
            'unknown-target': language.lorebookWorkspace.bardAnalysisErrorUnknownTarget,
            'entry-shape': language.lorebookWorkspace.bardAnalysisErrorEntryShape,
            'link-shape': language.lorebookWorkspace.bardAnalysisErrorLinkShape,
            'missing-source-hash': language.lorebookWorkspace.bardAnalysisErrorSourceChanged,
            'missing-targets': language.lorebookWorkspace.bardAnalysisErrorMissingTargets,
        }
        return labels[reason] ?? value
    }

    function isJsonProtocolFailure(value: string): boolean {
        if (value === 'bard-lore-analysis-invalid:invalid-json') return true
        const normalized = value.toLowerCase()
        return normalized.includes('structured output validation failed')
            || normalized.includes('structured-output validation failed')
    }

    function qualityIssueLabel(issue: BardLoreAnalysisQualityIssue): string {
        switch (issue.code) {
            case 'missing-summary': return language.lorebookWorkspace.bardAnalysisQualityMissingSummary
            case 'missing-tags': return language.lorebookWorkspace.bardAnalysisQualityMissingTags
            case 'composite-not-index-only': return language.lorebookWorkspace.bardAnalysisQualityCompositeInjection
            case 'composite-without-atoms': return language.lorebookWorkspace.bardAnalysisQualityCompositeAtoms
            case 'supporting-links-exceed-budget': return language.lorebookWorkspace.bardAnalysisQualitySupportingLinks(issue.detail ?? '')
        }
    }

    async function executeRun(initial: BardLoreAnalysisRun) {
        const nextController = new AbortController()
        controller?.abort()
        controller = nextController
        analyzing = true
        error = ''
        let next = initial
        const byId = new Map(entries.map((entry) => [entry.id, entry]))
        const { requestChatData } = await import('src/ts/process/request/request')
        try {
            for (let batchIndex = 0; batchIndex < next.batches.length; batchIndex += 1) {
                const batchState = next.batches[batchIndex]
                if (batchState.status !== 'pending') continue
                if (nextController.signal.aborted) break
                const batch = batchState.targetIds.map((id) => byId.get(id)).filter((entry): entry is BardLoreEntry => Boolean(entry))
                const sourceHashes = new Map(batch.map((entry) => [entry.id, fingerprintBardLoreEntry(entry)]))
                next = startBardLoreAnalysisBatch(next, batchState.id)
                saveRun(next)
                try {
                    if (batch.length !== batchState.targetIds.length) throw new Error(language.lorebookWorkspace.bardAnalysisMissingEntry)
                    const requestBatch = async (prompt: string, schema = bardLoreAnalysisSchema) => {
                        const response = await requestChatData({
                            formated: [{ role: 'user', content: prompt }],
                            bias: {},
                            useStreaming: false,
                            noMultiGen: true,
                            tools: [],
                            disablePromptCache: false,
                            maxTokens: next.settingsSnapshot.analysisOutputTokens,
                            temperature: next.settingsSnapshot.analysisTemperature,
                            schema,
                            extractJson: '',
                            logSource: 'other',
                            logPurpose: 'bard-lore-analysis',
                        }, 'model', nextController.signal)
                        if (response.type !== 'success') {
                            throw new Error(response.type === 'fail' && response.result.trim()
                                ? response.result
                                : language.lorebookWorkspace.bardAnalysisRequestFailed)
                        }
                        return response.result
                    }
                    const prompt = buildBardLoreAnalysisPrompt(
                        batch,
                        entries,
                        next.settingsSnapshot.router.filterFacetKeys,
                        next.languageSnapshot ?? 'bilingual',
                        'ko',
                    )
                    let parsed
                    try {
                        parsed = parseBardLoreAnalysisResponse(await requestBatch(prompt), batch, entries, sourceHashes)
                    }
                    catch (cause) {
                        const message = cause instanceof Error ? cause.message : String(cause)
                        if (
                            !isJsonProtocolFailure(message)
                            || batch.length !== 1
                            || nextController.signal.aborted
                        ) throw cause
                        const atomicRetry = !isBardLoreCompositeEntry(batch[0])
                        const retryPrompt = atomicRetry
                            ? buildBardLoreAtomicRetryPrompt(prompt)
                            : [
                                prompt,
                                'Previous response was not valid JSON. Regenerate the complete object from the beginning. Return exactly one JSON object matching the supplied schema, with no Markdown fence or commentary.',
                            ].join('\n\n')
                        parsed = parseBardLoreAnalysisResponse(await requestBatch(
                            retryPrompt,
                            atomicRetry ? bardLoreAtomicAnalysisSchema : bardLoreAnalysisSchema,
                        ), batch, entries, sourceHashes)
                    }
                    let audit = auditBardLoreAnalysisDraft(parsed, batch, next.settingsSnapshot)
                    if (audit.issues.length > 0 && !nextController.signal.aborted) {
                        const repairPrompt = buildBardLoreAnalysisQualityRepairPrompt(prompt, audit.issues)
                        parsed = parseBardLoreAnalysisResponse(await requestBatch(repairPrompt), batch, entries, sourceHashes)
                        audit = auditBardLoreAnalysisDraft(parsed, batch, next.settingsSnapshot)
                    }
                    if (nextController.signal.aborted) break
                    if (audit.issues.length > 0) {
                        const diagnostics = [...new Set(audit.issues.map((issue) =>
                            `${issue.code}${issue.detail ? `:${issue.detail}` : ''}`
                        ))].join(',')
                        throw new Error(`bard-lore-analysis-quality:${diagnostics}`)
                    }
                    next = completeBardLoreAnalysisBatch(next, batchState.id, parsed.entries)
                    saveRun(next)
                }
                catch (cause) {
                    if (nextController.signal.aborted) break
                    const message = cause instanceof Error ? cause.message : String(cause)
                    if (isJsonProtocolFailure(message) && batchState.targetIds.length > 1) {
                        const midpoint = Math.ceil(batchState.targetIds.length / 2)
                        const targetGroups = [
                            batchState.targetIds.slice(0, midpoint),
                            batchState.targetIds.slice(midpoint),
                        ]
                        const replacements = targetGroups.map((targetIds) => ({
                            id: createUuid(),
                            index: 0,
                            targetIds,
                            estimatedInputTokens: Math.ceil(
                                batchState.estimatedInputTokens * targetIds.length / batchState.targetIds.length,
                            ),
                            status: 'pending' as const,
                        }))
                        next = {
                            ...next,
                            updatedAt: new Date().toISOString(),
                            batches: [
                                ...next.batches.slice(0, batchIndex),
                                ...replacements,
                                ...next.batches.slice(batchIndex + 1),
                            ].map((item, index) => ({ ...item, index })),
                        }
                        saveRun(next)
                        batchIndex -= 1
                        continue
                    }
                    next = failBardLoreAnalysisBatch(
                        next,
                        batchState.id,
                        message,
                    )
                    saveRun(next)
                }
            }
            next = nextController.signal.aborted
                ? pauseBardLoreAnalysisRun(next)
                : finishBardLoreAnalysisRun(next)
            saveRun(next)
        }
        catch (cause) {
            if (!nextController.signal.aborted) error = cause instanceof Error ? cause.message : String(cause)
            saveRun(pauseBardLoreAnalysisRun(next))
        }
        finally {
            if (controller === nextController) controller = undefined
            analyzing = false
        }
    }

    function startAnalysis() {
        if (!plan || plannedTargets.length === 0) return
        const next = {
            ...createBardLoreAnalysisRun(
                plan,
                scope,
                workingSettings,
                createUuid,
                undefined,
                plannedLanguage,
            ),
            replaceLinks: qualityRepair,
        }
        saveRun(next)
        void executeRun(next)
    }

    function cancelAnalysis() {
        controller?.abort()
        if (currentRun) saveRun(pauseBardLoreAnalysisRun(currentRun))
    }

    function resumeAnalysis() {
        if (!currentRun) return
        const next = { ...currentRun, status: 'running' as const }
        saveRun(next)
        void executeRun(next)
    }

    function retryFailed() {
        if (!currentRun) return
        const next = retryFailedBardLoreAnalysisBatches(currentRun)
        saveRun(next)
        void executeRun(next)
    }

    function updateOverwrite(overwriteExisting: boolean) {
        if (!currentRun) return
        saveRun({ ...currentRun, overwriteExisting, updatedAt: new Date().toISOString() })
    }

    function applyDraft() {
        if (!currentRun) return
        const applied = applyBardLoreAnalysisDraft(
            entries,
            bardLoreAnalysisDraftFromRun(currentRun),
            { overwriteExisting: currentRun.overwriteExisting, replaceLinks: currentRun.replaceLinks },
        )
        conflicts = applied.conflicts
        if (applied.appliedIds.length > 0) onChange(applied.entries)

        const conflictIds = new Set(applied.conflicts.map((conflict) => conflict.id))
        const remainingBatches = currentRun.batches.flatMap((batch) => {
            if (batch.status !== 'complete') return [batch]
            const candidates = (batch.candidates ?? []).filter((candidate) => conflictIds.has(candidate.id))
            return candidates.length > 0 ? [{ ...batch, targetIds: candidates.map((candidate) => candidate.id), candidates }] : []
        })
        if (remainingBatches.length === 0) {
            saveRun(undefined)
            plan = null
            plannedTargets = []
            return
        }
        saveRun({
            ...currentRun,
            batches: remainingBatches,
            targetIds: remainingBatches.flatMap((batch) => batch.targetIds),
            status: remainingBatches.some((batch) => batch.status === 'pending' || batch.status === 'running')
                ? 'paused'
                : remainingBatches.some((batch) => batch.status === 'complete') ? 'review' : 'failed',
            updatedAt: new Date().toISOString(),
        })
    }

    function discardRun() {
        controller?.abort()
        saveRun(undefined)
        plan = null
        plannedTargets = []
        conflicts = []
        error = ''
    }

    function handleOpenChange(next: boolean) {
        if (!next && analyzing) cancelAnalysis()
        open = next
    }

    onDestroy(() => {
        controller?.abort()
        if (currentRun?.status === 'running') onAnalysisRunChange(pauseBardLoreAnalysisRun(currentRun))
    })
</script>

<section class:compact class="analysis-launcher" aria-label={language.lorebookWorkspace.bardAiAnalysis}>
    {#if !compact}
        <div class="launcher-heading">
            <div>
                <strong>{language.lorebookWorkspace.bardAiAnalysis}</strong>
                <p>{language.lorebookWorkspace.bardAnalysisDescription}</p>
            </div>
            {#if currentRun}<span class="run-badge">{language.lorebookWorkspace.bardAnalysisDraftSaved(candidateCount)}</span>{/if}
        </div>
        <div
            class:quality-pass={qualityAudit.issues.length === 0}
            class:quality-fail={qualityAudit.issues.length > 0}
            class="quality-status"
            data-bard-lore-quality-status={qualityAudit.issues.length === 0 ? 'pass' : 'fail'}
        >
            <strong>{qualityAudit.issues.length === 0
                ? language.lorebookWorkspace.bardAnalysisQualityPassed
                : language.lorebookWorkspace.bardAnalysisQualityNeedsWork(qualityAudit.failedEntryIds.length, qualityAudit.issues.length)}</strong>
            <small>{language.lorebookWorkspace.bardAnalysisQualityDescription}</small>
            {#if qualityAudit.issues.length > 0}
                <details class="quality-details">
                    <summary>{language.lorebookWorkspace.bardAnalysisQualityShowIssues}</summary>
                    <ul>
                        {#each qualityAudit.issues as issue}
                            <li data-bard-lore-quality-issue={issue.code}>
                                <strong>{entries.find((entry) => entry.id === issue.entryId)?.comment || issue.entryId}</strong>
                                <span>{qualityIssueLabel(issue)}</span>
                            </li>
                        {/each}
                    </ul>
                </details>
                {#if !currentRun}
                    <button
                        type="button"
                        class="secondary"
                        data-bard-lore-quality-repair
                        disabled={planning || analyzing}
                        onclick={openQualityRepair}
                    >{language.lorebookWorkspace.bardAnalysisQualityRepair(qualityAudit.failedEntryIds.length)}</button>
                {/if}
            {/if}
        </div>
        <div class="coverage-grid">
            <div><strong>{eligibleEntries.length}</strong><span>{language.lorebookWorkspace.bardAnalysisEntries}</span></div>
            <div><strong>{untypedCount}</strong><span>{language.lorebookWorkspace.bardAnalysisUntyped}</span></div>
            <div><strong>{missingSummaryCount}</strong><span>{language.lorebookWorkspace.bardAnalysisNoSummary}</span></div>
            <div><strong>{missingTagsCount}</strong><span>{language.lorebookWorkspace.bardAnalysisNoTags}</span></div>
        </div>
    {/if}
    <button type="button" class="primary" data-bard-lore-analysis-open onclick={openWorkbench}>
        {currentRun ? language.lorebookWorkspace.bardAnalysisResumeReview : language.lorebookWorkspace.bardAnalysisOpen}
    </button>
    {#if compact && currentRun}
        <small>{language.lorebookWorkspace.bardAnalysisDraftSaved(candidateCount)}</small>
    {/if}
</section>

<ShDialog
    {open}
    onOpenChange={handleOpenChange}
    closeOnEscape
    closeOnOutsideClick={false}
    tier="alert"
    size="xl"
    contentClass="bard-analysis-dialog"
    bodyClass="bard-analysis-body"
    closeAriaLabel={language.lorebookWorkspace.close}
>
    {#snippet title()}{language.lorebookWorkspace.bardAiAnalysis}{/snippet}
    {#snippet description()}{language.lorebookWorkspace.bardAnalysisDialogDescription}{/snippet}

    <section class="analysis-settings" aria-label={language.lorebookWorkspace.bardAnalysisSettings}>
        <div class="section-heading">
            <div>
                <strong>{language.lorebookWorkspace.bardAnalysisSettings}</strong>
                <small>{language.lorebookWorkspace.bardAnalysisSettingsHint}</small>
            </div>
        </div>
        <div class="settings-grid">
            <label>
                <span>{language.lorebookWorkspace.bardAnalysisBatchEntries}</span>
                <input type="number" min="0" step="1" value={workingSettings.analysisBatchEntries}
                    data-bard-lore-analysis-setting="analysisBatchEntries" disabled={analyzing}
                    onchange={(event) => updateAnalysisSetting('analysisBatchEntries', event.currentTarget.value)} />
            </label>
            <label>
                <span>{language.lorebookWorkspace.bardAnalysisInputTokens}</span>
                <input type="number" min="0" step="1" value={workingSettings.analysisInputTokens}
                    data-bard-lore-analysis-setting="analysisInputTokens" disabled={analyzing}
                    onchange={(event) => updateAnalysisSetting('analysisInputTokens', event.currentTarget.value)} />
            </label>
            <label>
                <span>{language.lorebookWorkspace.bardAnalysisOutputTokens}</span>
                <input type="number" min="0" step="1" value={workingSettings.analysisOutputTokens}
                    data-bard-lore-analysis-setting="analysisOutputTokens" disabled={analyzing}
                    onchange={(event) => updateAnalysisSetting('analysisOutputTokens', event.currentTarget.value)} />
            </label>
            <label>
                <span>{language.lorebookWorkspace.bardAnalysisLinkedDepth}</span>
                <input type="number" min="0" step="1" value={workingSettings.analysisLinkedDepth}
                    data-bard-lore-analysis-setting="analysisLinkedDepth" disabled={analyzing || Boolean(currentRun)}
                    onchange={(event) => updateAnalysisSetting('analysisLinkedDepth', event.currentTarget.value)} />
            </label>
            <label>
                <span>{language.lorebookWorkspace.bardAnalysisTemperature}</span>
                <input type="number" min="0" step="0.05" value={workingSettings.analysisTemperature}
                    data-bard-lore-analysis-setting="analysisTemperature" disabled={analyzing}
                    onchange={(event) => updateAnalysisSetting('analysisTemperature', event.currentTarget.value)} />
            </label>
        </div>
        {#if currentRun}
            <p class="notice">{language.lorebookWorkspace.bardAnalysisSettingsNextRun}</p>
        {/if}
    </section>

    {#if !currentRun}
        <div class="planning-layout">
            <label class="field">
                <span>{language.lorebookWorkspace.bardAnalysisScope}</span>
                <select bind:value={scope} onchange={() => void prepare()}>
                    {#if activeEntryId}
                        <option value="entry">{language.lorebookWorkspace.bardAnalyzeEntry}</option>
                        <option value="connected">{language.lorebookWorkspace.bardAnalyzeConnected}</option>
                    {/if}
                    <option value="characters">{language.lorebookWorkspace.bardAnalyzeCharacters}</option>
                    <option value="all">{language.lorebookWorkspace.bardAnalyzeAll}</option>
                </select>
            </label>
            {#if planning}
                <p class="status-line">{language.lorebookWorkspace.bardAnalysisPlanning}</p>
            {:else if plan}
                <div class="estimate-grid" data-bard-lore-analysis-plan>
                    <div><span>{language.lorebookWorkspace.bardAnalysisTargetCount}</span><strong>{plannedTargets.length}</strong></div>
                    <div><span>{language.lorebookWorkspace.bardAnalysisRequestCount}</span><strong>{plan.batches.length}–{plan.batches.length * 2}</strong></div>
                    <div><span>{language.lorebookWorkspace.bardAnalysisEstimatedInput}</span><strong>{plan.totalInputTokens.toLocaleString()}</strong></div>
                    <div><span>{language.lorebookWorkspace.bardAnalysisMaximumOutput}</span><strong>{(plan.batches.length * workingSettings.analysisOutputTokens * 2).toLocaleString()}</strong></div>
                </div>
                <p class="notice">{language.lorebookWorkspace.bardAnalysisEstimateNotice(plan.batches.length)}</p>
                <section class="target-preview" aria-label={language.lorebookWorkspace.bardAnalysisTargetPreview}>
                    <div class="section-heading">
                        <div><strong>{language.lorebookWorkspace.bardAnalysisTargetPreview}</strong><small>{language.lorebookWorkspace.bardAnalysisTargetPreviewDescription}</small></div>
                        <span>{plannedTargets.length}</span>
                    </div>
                    <div class="target-list">
                        {#each plannedTargets as entry}
                            <details data-bard-lore-analysis-target={entry.id}>
                                <summary>
                                    <span>{entry.comment || entry.id}</span>
                                    <small>{language.lorebookWorkspace.bardAnalysisBatchLabel(batchNumberForTarget(entry.id))}</small>
                                </summary>
                                <div class="target-detail">
                                    <small>{language.lorebookWorkspace.bardAnalysisKeys}: {entry.key || '—'}{entry.secondkey ? ` · ${entry.secondkey}` : ''}</small>
                                    <pre>{entry.content || language.lorebookWorkspace.bardAnalysisNoContent}</pre>
                                </div>
                            </details>
                        {/each}
                    </div>
                </section>
                <button type="button" class="primary" data-bard-lore-analyze onclick={startAnalysis}>
                    {language.lorebookWorkspace.bardAnalysisStart(plan.batches.length)}
                </button>
            {/if}
        </div>
    {:else}
        <div class="run-layout">
            <div class="run-summary">
                <div><span>{language.lorebookWorkspace.bardAnalysisProgress}</span><strong>{completeCount + failedCount} / {currentRun.batches.length}</strong></div>
                <div><span>{language.lorebookWorkspace.bardAnalysisProcessedEntries}</span><strong>{processedEntries} / {currentRun.targetIds.length}</strong></div>
                <div><span>{language.lorebookWorkspace.bardAnalysisFailedBatches}</span><strong>{failedCount}</strong></div>
            </div>
            <progress value={completeCount + failedCount} max={Math.max(1, currentRun.batches.length)}></progress>

            <section class="target-preview" aria-label={language.lorebookWorkspace.bardAnalysisTargetPreview}>
                <div class="section-heading">
                    <div><strong>{language.lorebookWorkspace.bardAnalysisTargetPreview}</strong><small>{language.lorebookWorkspace.bardAnalysisTargetPreviewDescription}</small></div>
                    <span>{currentRun.targetIds.length}</span>
                </div>
                <div class="target-list">
                    {#each displayRunTargets() as entry}
                        <details data-bard-lore-analysis-target={entry.id}>
                            <summary>
                                <span>{entry.comment || entry.id}</span>
                                <small>{language.lorebookWorkspace.bardAnalysisBatchLabel(batchNumberForTarget(entry.id))}</small>
                            </summary>
                            <div class="target-detail">
                                <small>{language.lorebookWorkspace.bardAnalysisKeys}: {entry.key || '—'}{entry.secondkey ? ` · ${entry.secondkey}` : ''}</small>
                                <pre>{entry.content || language.lorebookWorkspace.bardAnalysisNoContent}</pre>
                            </div>
                        </details>
                    {/each}
                </div>
            </section>

            {#if failedCount > 0}
                <section class="failure-list" aria-label={language.lorebookWorkspace.bardAnalysisFailureDetails}>
                    <div class="section-heading"><div><strong>{language.lorebookWorkspace.bardAnalysisFailureDetails}</strong></div><span>{failedCount}</span></div>
                    {#each currentRun.batches.filter((batch) => batch.status === 'failed') as batch}
                        <article class="failure-card" data-bard-lore-analysis-failure>
                            <div><strong>{language.lorebookWorkspace.bardAnalysisBatchLabel(batch.index + 1)}</strong><span>{validationErrorLabel(batch.error)}</span></div>
                            <small>{language.lorebookWorkspace.bardAnalysisFailureTargets}: {batch.targetIds.map((id) => entries.find((entry) => entry.id === id)?.comment || id).join(', ')}</small>
                        </article>
                    {/each}
                </section>
            {/if}

            {#if analyzing}
                <p class="status-line">{language.lorebookWorkspace.bardAnalysisRunningBatch(completeCount + failedCount + 1, currentRun.batches.length)}</p>
                <button type="button" class="secondary" data-bard-lore-analysis-cancel onclick={cancelAnalysis}>
                    {language.lorebookWorkspace.bardAnalysisCancelKeep}
                </button>
            {:else}
                <div class="run-actions">
                    {#if pendingCount > 0}
                        <button type="button" class="primary" data-bard-lore-analysis-resume onclick={resumeAnalysis}>{language.lorebookWorkspace.bardAnalysisResume}</button>
                    {/if}
                    {#if failedCount > 0}
                        <button type="button" class="secondary" data-bard-lore-analysis-retry onclick={retryFailed}>{language.lorebookWorkspace.bardAnalysisRetryFailed(failedCount)}</button>
                    {/if}
                </div>
            {/if}

            {#if candidateCount > 0}
                <div class="review-heading">
                    <div><strong>{language.lorebookWorkspace.bardAnalysisReview}</strong><small>{language.lorebookWorkspace.bardAnalysisReviewCount(candidateCount)}</small></div>
                    <label class="overwrite">
                        <input type="checkbox" checked={currentRun.overwriteExisting} onchange={(event) => updateOverwrite(event.currentTarget.checked)} />
                        {language.lorebookWorkspace.bardOverwriteMetadata}
                    </label>
                </div>
                <div class="drafts">
                    {#each bardLoreAnalysisDraftFromRun(currentRun).entries as candidate}
                        <article data-bard-lore-analysis-draft={candidate.id}>
                            <div><strong>{entries.find((entry) => entry.id === candidate.id)?.comment || candidate.id}</strong><span>{candidate.kind}</span></div>
                            <p>{candidate.summary || language.lorebookWorkspace.bardAnalysisEmptySummary}</p>
                            <small>{candidate.tags.join(' · ')}</small>
                            {#if candidate.links.length > 0}<small>{candidate.links.map((link) => link.targetId + ' · ' + link.relation).join(', ')}</small>{/if}
                            {#if candidate.atoms && candidate.atoms.length > 0}
                                <details data-bard-lore-analysis-atoms={candidate.id}>
                                    <summary>{language.lorebookWorkspace.bardAnalysisAtoms(candidate.atoms.length)}</summary>
                                    {#each candidate.atoms as atom}
                                        <div class="atom-preview">
                                            <strong>{atom.name}</strong><span>{atom.kind}</span>
                                            <p>{atom.content}</p>
                                            <small>{atom.facets.map((facet) => `${facet.key}=${facet.value}`).join(' · ')}</small>
                                        </div>
                                    {/each}
                                </details>
                            {/if}
                        </article>
                    {/each}
                </div>
                <button type="button" class="primary" data-bard-lore-analysis-apply disabled={analyzing} onclick={applyDraft}>
                    {language.lorebookWorkspace.bardApproveAnalysis}
                </button>
            {/if}
            <button type="button" class="danger" disabled={analyzing} onclick={discardRun}>{language.lorebookWorkspace.bardDiscardAnalysis}</button>
        </div>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
    {#if conflicts.length > 0}<p class="error">{language.lorebookWorkspace.bardAnalysisConflicts(conflicts.length)}</p>{/if}
    <p class="close-behavior">{language.lorebookWorkspace.bardAnalysisCloseBehavior}</p>
</ShDialog>

<style>
    .analysis-launcher { display: grid; gap: .8rem; margin-top: .75rem; padding: .9rem; border: 1px solid var(--color-darkborderc); border-radius: .7rem; background: color-mix(in srgb, var(--color-selected) 18%, transparent); }
    .analysis-launcher.compact { margin: 0; padding: .65rem 0 0; border-width: 1px 0 0; border-radius: 0; background: transparent; }
    .launcher-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: .7rem; }
    .launcher-heading p { margin: .15rem 0 0; color: var(--color-textcolor2); font-size: .78rem; line-height: 1.45; }
    .run-badge { padding: .25rem .45rem; border-radius: 99rem; background: var(--color-selected); font-size: .7rem; white-space: nowrap; }
    .coverage-grid, .estimate-grid, .run-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .5rem; }
    .coverage-grid > div, .estimate-grid > div, .run-summary > div { display: grid; gap: .15rem; padding: .6rem; border: 1px solid var(--color-darkborderc); border-radius: .5rem; background: var(--color-darkbg); }
    .coverage-grid strong, .estimate-grid strong, .run-summary strong { font-size: 1.05rem; }
    .coverage-grid span, .estimate-grid span, .run-summary span { color: var(--color-textcolor2); font-size: .7rem; }
    .quality-status { display: grid; gap: .15rem; padding: .65rem .75rem; border: 1px solid; border-radius: .55rem; }
    .quality-status small { color: var(--color-textcolor2); line-height: 1.4; }
    .quality-pass { border-color: var(--color-success); background: color-mix(in srgb, var(--color-success) 12%, transparent); color: var(--color-success); }
    .quality-fail { border-color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 12%, transparent); color: var(--color-warning); }
    .quality-details { color: var(--color-textcolor); font-size: .75rem; }
    .quality-details summary { cursor: pointer; }
    .quality-details ul { display: grid; gap: .3rem; margin: .45rem 0 0; padding-left: 1.2rem; }
    .quality-details li span { margin-left: .35rem; color: var(--color-textcolor2); }
    button, select, input { min-height: 2.4rem; padding: .48rem .7rem; border: 1px solid var(--color-darkborderc); border-radius: .5rem; color: var(--color-textcolor); }
    button { font-weight: 650; }
    button:disabled { cursor: not-allowed; opacity: .55; }
    .primary { background: var(--color-info); color: var(--color-on-info); }
    .secondary, select, input { background: var(--color-darkbg); }
    .danger { background: color-mix(in srgb, var(--color-red) 18%, transparent); color: var(--color-red); }
    :global(.bard-analysis-dialog) { width: min(calc(100vw - 2rem), 72rem); max-width: none; }
    :global(.bard-analysis-body) { min-width: 0; }
    .planning-layout, .run-layout { display: grid; gap: .85rem; }
    .analysis-settings, .target-preview, .failure-list { display: grid; gap: .65rem; padding: .8rem; border: 1px solid var(--color-darkborderc); border-radius: .65rem; background: color-mix(in srgb, var(--color-selected) 12%, var(--color-darkbg)); }
    .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: .8rem; }
    .section-heading > div { display: grid; gap: .15rem; }
    .section-heading small { color: var(--color-textcolor2); font-size: .72rem; font-weight: 400; }
    .section-heading > span { min-width: 2rem; padding: .18rem .45rem; border-radius: 99rem; background: var(--color-selected); text-align: center; font-size: .72rem; }
    .settings-grid { display: grid; grid-template-columns: repeat(5, minmax(8rem, 1fr)); gap: .55rem; }
    .settings-grid label { display: grid; gap: .3rem; color: var(--color-textcolor2); font-size: .7rem; }
    .settings-grid input { width: 100%; font-variant-numeric: tabular-nums; }
    .target-list { display: grid; gap: .35rem; max-height: 30vh; overflow: auto; padding-right: .2rem; }
    .target-list details { border: 1px solid color-mix(in srgb, var(--color-darkborderc) 78%, transparent); border-radius: .48rem; background: var(--color-darkbg); }
    .target-list summary { display: flex; align-items: center; justify-content: space-between; gap: .8rem; padding: .55rem .65rem; cursor: pointer; }
    .target-list summary span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
    .target-list summary small { color: var(--color-textcolor2); white-space: nowrap; }
    .target-detail { display: grid; gap: .45rem; padding: 0 .65rem .65rem; }
    .target-detail > small { color: var(--color-textcolor2); }
    .target-detail pre { max-height: 16rem; margin: 0; padding: .65rem; overflow: auto; border-radius: .4rem; background: color-mix(in srgb, var(--color-selected) 20%, var(--color-darkbg)); color: var(--color-textcolor); font: inherit; font-size: .76rem; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    .failure-list { border-color: color-mix(in srgb, var(--color-red) 42%, var(--color-darkborderc)); }
    .failure-card { background: color-mix(in srgb, var(--color-red) 9%, var(--color-darkbg)); }
    .failure-card > div { align-items: flex-start; flex-direction: column; }
    .failure-card span { border-radius: .35rem; background: color-mix(in srgb, var(--color-red) 14%, transparent); color: var(--color-red); }
    .close-behavior { margin: -.1rem 0 0; color: var(--color-textcolor2); font-size: .7rem; text-align: center; }
    .field { display: grid; gap: .35rem; font-size: .78rem; font-weight: 650; }
    .notice, .status-line { margin: 0; color: var(--color-textcolor2); font-size: .78rem; line-height: 1.5; }
    .run-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    progress { width: 100%; height: .65rem; accent-color: var(--color-info); }
    .review-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; padding-top: .35rem; border-top: 1px solid var(--color-darkborderc); }
    .review-heading > div { display: grid; gap: .1rem; }
    .review-heading small { color: var(--color-textcolor2); }
    .overwrite { display: flex; align-items: center; gap: .4rem; color: var(--color-textcolor2); font-size: .76rem; }
    .drafts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: .55rem; max-height: 40vh; overflow: auto; padding-right: .2rem; }
    .atom-preview { display: grid; gap: .2rem; margin-top: .35rem; padding: .45rem; border: 1px solid var(--color-darkborderc); border-radius: .4rem; }
    article { display: grid; align-content: start; gap: .35rem; padding: .7rem; border: 1px solid var(--color-darkborderc); border-radius: .55rem; background: var(--color-darkbg); }
    article > div { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    article span { padding: .15rem .35rem; border-radius: 99rem; background: var(--color-selected); color: var(--color-textcolor2); font-size: .68rem; }
    article p { margin: 0; line-height: 1.45; }
    article small { color: var(--color-textcolor2); }
    .error { margin: 0; color: var(--color-red); }
    @media (max-width: 700px) {
        .coverage-grid, .estimate-grid, .run-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .launcher-heading, .review-heading { align-items: stretch; flex-direction: column; }
        .settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
</style>
