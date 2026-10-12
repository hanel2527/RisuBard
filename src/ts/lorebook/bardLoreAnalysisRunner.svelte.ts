import { v4 as createUuid } from 'uuid'
import { language } from 'src/lang'
import { notifyError, notifySuccess } from 'src/ts/alert'
import { DBState } from 'src/ts/stores.svelte'
import { requestWithProviderOutputLimit } from 'src/ts/risubard/providerOutputTokenLimit'
import { diagnoseBardLoreAnalysisFailure, type BardLoreFailureContext } from './bardLoreAnalysisDiagnostics'
import { createDefaultBardLoreInstructionPreset } from './bardLoreInstructionPreset'
import {
    fingerprintBardLoreEntry,
    materializeBardLoreEntries,
    reconcileBardLoreAnalysisRun,
    type BardLoreAnalysisRun,
    type BardLoreEntry,
} from './bardLore'
import {
    BARD_LORE_PARTIAL_RECOVERY_ENABLED,
    auditBardLoreAnalysisDraft,
    bardLoreAnalysisDraftFromRun,
    bardLoreAnalysisSchema,
    bardLoreAtomicAnalysisSchema,
    buildBardLoreAnalysisPrompt,
    buildBardLoreAnalysisQualityRepairPrompt,
    buildBardLoreAtomicRetryPrompt,
    completeBardLoreAnalysisBatch,
    failBardLoreAnalysisBatch,
    finishBardLoreAnalysisRun,
    isBardLoreCompositeEntry,
    parseBardLoreAnalysisResponse,
    partitionRecoveredBardLoreAnalysisBatch,
    pauseBardLoreAnalysisRun,
    recoverBardLoreAnalysisResponse,
    startBardLoreAnalysisBatch,
} from './bardLoreAnalysis'

/**
 * Where an analysis job reads its lore and stores its run. The job outlives the
 * analysis window, so it must never resolve its owner through the selected character.
 */
export interface BardLoreAnalysisJobTarget {
    key: string
    label: () => string
    /** undefined means the owner no longer exists. */
    readEntries: () => BardLoreEntry[] | undefined
    readRun: () => BardLoreAnalysisRun | undefined
    writeRun: (run: BardLoreAnalysisRun) => void
}

const controllers = new Map<string, AbortController>()
const activeRunIds = $state<Record<string, string>>({})
const jobErrors = $state<Record<string, string>>({})

export function createCharacterBardLoreAnalysisTarget(chaId: string): BardLoreAnalysisJobTarget {
    const find = () => DBState.db.characters?.find((character) => character?.chaId === chaId)
    return {
        key: `character:${chaId}`,
        label: () => find()?.name ?? '',
        readEntries: () => {
            const character = find()
            return character?.bardLore
                ? materializeBardLoreEntries(character.bardLore, character.globalLore ?? [])
                : undefined
        },
        readRun: () => find()?.bardLore?.analysisRun,
        writeRun: (run) => {
            const character = find()
            if (character?.bardLore) character.bardLore.analysisRun = run
        },
    }
}

export function isBardLoreAnalysisJobRunning(key: string): boolean {
    return key in activeRunIds
}

export function bardLoreAnalysisJobError(key: string): string {
    return jobErrors[key] ?? ''
}

export function clearBardLoreAnalysisJobError(key: string): void {
    delete jobErrors[key]
}

export function stopBardLoreAnalysisJob(target: BardLoreAnalysisJobTarget): void {
    const controller = controllers.get(target.key)
    if (!controller) return
    const runId = activeRunIds[target.key]
    controllers.delete(target.key)
    delete activeRunIds[target.key]
    controller.abort()
    const stored = target.readRun()
    if (stored && stored.id === runId) target.writeRun(pauseBardLoreAnalysisRun(stored))
}

/** Drops every job without writing, so tests cannot leak requests into each other. */
export function abortAllBardLoreAnalysisJobs(): void {
    const running = [...controllers.values()]
    controllers.clear()
    for (const key of Object.keys(activeRunIds)) delete activeRunIds[key]
    for (const key of Object.keys(jobErrors)) delete jobErrors[key]
    for (const controller of running) controller.abort()
}

export function isBardLoreAnalysisJsonProtocolFailure(value: string): boolean {
    if (value === 'bard-lore-analysis-invalid:invalid-json') return true
    const normalized = value.toLowerCase()
    return normalized.includes('structured output validation failed')
        || normalized.includes('structured-output validation failed')
}

export function startBardLoreAnalysisJob(
    target: BardLoreAnalysisJobTarget,
    initial: BardLoreAnalysisRun,
): Promise<void> {
    controllers.get(target.key)?.abort()
    const controller = new AbortController()
    controllers.set(target.key, controller)
    activeRunIds[target.key] = initial.id
    delete jobErrors[target.key]
    return executeJob(target, initial, controller)
}

async function executeJob(
    target: BardLoreAnalysisJobTarget,
    initial: BardLoreAnalysisRun,
    controller: AbortController,
): Promise<void> {
    const runId = initial.id
    const isCurrent = () => controllers.get(target.key) === controller
    const ownsRun = () => isCurrent() && target.readRun()?.id === runId
    let next = initial
    let entries: BardLoreEntry[] = []

    // Lore edits reconcile the saved run against the current entries; keep doing
    // so here, or a later write would bring back targets the user removed.
    const reconcile = (run: BardLoreAnalysisRun) => {
        const latest = target.readEntries()
        if (!latest) return undefined
        entries = latest
        return reconcileBardLoreAnalysisRun(run, new Set(latest.map((entry) => entry.id)))
    }
    const commit = (run: BardLoreAnalysisRun): boolean => {
        if (!ownsRun()) {
            controller.abort()
            return false
        }
        const reconciled = reconcile(run)
        if (!reconciled) {
            controller.abort()
            return false
        }
        // The overwrite switch stays editable while a job runs.
        target.writeRun({ ...reconciled, overwriteExisting: target.readRun()?.overwriteExisting ?? reconciled.overwriteExisting })
        return true
    }

    try {
        const { requestChatData } = await import('src/ts/process/request/request')
        for (;;) {
            if (controller.signal.aborted || !ownsRun()) break
            const reconciled = reconcile(next)
            if (!reconciled) {
                controller.abort()
                break
            }
            next = reconciled
            // Every earlier batch is settled, so the first pending batch keeps the original order
            // and also picks up the halves of a split batch.
            const batchIndex = next.batches.findIndex((batch) => batch.status === 'pending')
            if (batchIndex < 0) break
            const batchState = next.batches[batchIndex]
            const byId = new Map(entries.map((entry) => [entry.id, entry]))
            const batchEntries = entries
            const batch = batchState.targetIds.map((id) => byId.get(id)).filter((entry): entry is BardLoreEntry => Boolean(entry))
            const sourceHashes = new Map(batch.map((entry) => [entry.id, fingerprintBardLoreEntry(entry)]))
            next = startBardLoreAnalysisBatch(next, batchState.id)
            if (!commit(next)) break
            let responseText = ''
            let diagnosticContext: BardLoreFailureContext = { error: '' }
            let attempt = 0
            try {
                if (batch.length !== batchState.targetIds.length) throw new Error(language.lorebookWorkspace.bardAnalysisMissingEntry)
                const requestBatch = async (prompt: string, schema = bardLoreAnalysisSchema) => {
                    if (!ownsRun()) {
                        controller.abort()
                        throw new Error(language.lorebookWorkspace.bardAnalysisRequestFailed)
                    }
                    // A failed retry must never reuse the previous attempt's text or metadata.
                    responseText = ''
                    diagnosticContext = {
                        error: '', attempt: ++attempt, entryCount: batch.length,
                        estimatedInputTokens: batchState.estimatedInputTokens,
                        inputTokenLimit: next.settingsSnapshot.analysisInputTokens,
                        outputTokenLimit: next.settingsSnapshot.analysisOutputTokens,
                    }
                    const response = await requestWithProviderOutputLimit<Parameters<typeof requestChatData>[0], Awaited<ReturnType<typeof requestChatData>>>({
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
                        logPurpose: 'bard-lore-analysis' as const,
                    }, (request) => requestChatData(request, 'model', controller.signal))
                    diagnosticContext.responseType = response.type
                    if (response.type === 'success' || response.type === 'fail') {
                        diagnosticContext.finishReason = response.finishReason
                        diagnosticContext.usage = response.usage
                        diagnosticContext.model = response.model
                    }
                    if (response.type !== 'success') {
                        throw new Error(response.type === 'fail' && response.result.trim()
                            ? response.result
                            : language.lorebookWorkspace.bardAnalysisRequestFailed)
                    }
                    responseText = response.result
                    diagnosticContext.responseText = responseText
                    return responseText
                }
                const prompt = buildBardLoreAnalysisPrompt(
                    batch,
                    batchEntries,
                    next.settingsSnapshot.router.filterFacetKeys,
                    next.languageSnapshot ?? 'bilingual',
                    'ko',
                    next.instructionPresetSnapshot ?? createDefaultBardLoreInstructionPreset(),
                )
                let parsed
                try {
                    parsed = parseBardLoreAnalysisResponse(await requestBatch(prompt), batch, batchEntries, sourceHashes)
                }
                catch (cause) {
                    const message = cause instanceof Error ? cause.message : String(cause)
                    if (
                        !isBardLoreAnalysisJsonProtocolFailure(message)
                        || batch.length !== 1
                        || controller.signal.aborted
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
                    ), batch, batchEntries, sourceHashes)
                }
                let audit = auditBardLoreAnalysisDraft(parsed, batch, next.settingsSnapshot)
                if (audit.issues.length > 0 && !controller.signal.aborted) {
                    const repairPrompt = buildBardLoreAnalysisQualityRepairPrompt(prompt, audit.issues)
                    parsed = parseBardLoreAnalysisResponse(await requestBatch(repairPrompt), batch, batchEntries, sourceHashes)
                    audit = auditBardLoreAnalysisDraft(parsed, batch, next.settingsSnapshot)
                }
                if (controller.signal.aborted) break
                if (audit.issues.length > 0) {
                    const diagnostics = [...new Set(audit.issues.map((issue) =>
                        `${issue.code}${issue.detail ? `:${issue.detail}` : ''}`
                    ))].join(',')
                    throw new Error(`bard-lore-analysis-quality:${diagnostics}`)
                }
                next = completeBardLoreAnalysisBatch(next, batchState.id, parsed.entries)
                commit(next)
            }
            catch (cause) {
                if (controller.signal.aborted) break
                const message = cause instanceof Error ? cause.message : String(cause)
                const diagnostic = diagnoseBardLoreAnalysisFailure({ ...diagnosticContext, error: message })
                next = { ...next, batches: next.batches.map((item) => item.id === batchState.id ? { ...item, diagnostic } : item) }
                let failedBatch = batchState
                if (BARD_LORE_PARTIAL_RECOVERY_ENABLED && isBardLoreAnalysisJsonProtocolFailure(message) && responseText) {
                    const recovered = recoverBardLoreAnalysisResponse(responseText, batch, batchEntries, sourceHashes)
                    const qualityFailedIds = new Set(auditBardLoreAnalysisDraft(
                        { entries: recovered.completeEntries },
                        batch,
                        next.settingsSnapshot,
                    ).failedEntryIds)
                    const qualityFailedEntries = recovered.completeEntries.filter((candidate) => qualityFailedIds.has(candidate.id))
                    const recovery = {
                        ...recovered,
                        completeEntries: recovered.completeEntries.filter((candidate) => !qualityFailedIds.has(candidate.id)),
                        incompleteEntries: [...recovered.incompleteEntries, ...qualityFailedEntries],
                        recoveredFields: {
                            ...recovered.recoveredFields,
                            ...Object.fromEntries(qualityFailedEntries.map((candidate) => [
                                candidate.id,
                                ['kind', 'activation', 'aliases', 'tags', 'summary', 'facets', 'injection', 'atoms', 'links'],
                            ])),
                        },
                        unresolvedTargetIds: [...new Set([
                            ...recovered.unresolvedTargetIds,
                            ...qualityFailedEntries.map((candidate) => candidate.id),
                        ])],
                    }
                    if (recovery.completeEntries.length > 0 || recovery.incompleteEntries.length > 0) {
                        next = partitionRecoveredBardLoreAnalysisBatch(
                            next,
                            batchState.id,
                            recovery,
                            message,
                            createUuid,
                        )
                        const unresolvedIndex = next.batches.findIndex((item, index) =>
                            index >= batchIndex && item.status === 'failed' && item.targetIds.some((id) => batchState.targetIds.includes(id)),
                        )
                        if (unresolvedIndex < 0 || batchState.targetIds.length === 1) {
                            commit(next)
                            continue
                        }
                        failedBatch = next.batches[unresolvedIndex]
                        if (failedBatch.targetIds.length === 1) {
                            next = { ...next, batches: next.batches.map((item, index) =>
                                index === unresolvedIndex ? { ...item, status: 'pending' as const, error: undefined, diagnostic: undefined } : item,
                            ) }
                            commit(next)
                            continue
                        }
                    }
                }
                if (isBardLoreAnalysisJsonProtocolFailure(message) && failedBatch.targetIds.length > 1) {
                    const failedBatchIndex = next.batches.findIndex((item) => item.id === failedBatch.id)
                    const midpoint = Math.ceil(failedBatch.targetIds.length / 2)
                    const targetGroups = [
                        failedBatch.targetIds.slice(0, midpoint),
                        failedBatch.targetIds.slice(midpoint),
                    ]
                    const replacements = targetGroups.map((targetIds) => ({
                        id: createUuid(),
                        index: 0,
                        targetIds,
                        estimatedInputTokens: Math.ceil(
                            failedBatch.estimatedInputTokens * targetIds.length / failedBatch.targetIds.length,
                        ),
                        status: 'pending' as const,
                    }))
                    next = {
                        ...next,
                        updatedAt: new Date().toISOString(),
                        batches: [
                            ...next.batches.slice(0, failedBatchIndex),
                            ...replacements,
                            ...next.batches.slice(failedBatchIndex + 1),
                        ].map((item, index) => ({ ...item, index })),
                    }
                    commit(next)
                    continue
                }
                next = failBardLoreAnalysisBatch(
                    next,
                    batchState.id,
                    message,
                )
                commit(next)
            }
        }
        if (!isCurrent()) return
        const finished = !controller.signal.aborted
        next = finished ? finishBardLoreAnalysisRun(next) : pauseBardLoreAnalysisRun(next)
        if (commit(next) && finished) notifyFinished(target, next)
    }
    catch (cause) {
        if (!isCurrent()) return
        if (!controller.signal.aborted) {
            const message = cause instanceof Error ? cause.message : String(cause)
            jobErrors[target.key] = message
            notifyError(message)
        }
        commit(pauseBardLoreAnalysisRun(next))
    }
    finally {
        if (isCurrent()) {
            controllers.delete(target.key)
            delete activeRunIds[target.key]
        }
    }
}

function notifyFinished(target: BardLoreAnalysisJobTarget, run: BardLoreAnalysisRun) {
    const name = target.label()
    if (run.status === 'review') {
        // The user may be on another screen, so keep the notice up longer than a click confirmation.
        notifySuccess(
            language.lorebookWorkspace.bardAnalysisBackgroundComplete(name, bardLoreAnalysisDraftFromRun(run).entries.length),
            { duration: 10_000 },
        )
    }
    else {
        notifyError(language.lorebookWorkspace.bardAnalysisBackgroundFailed(name))
    }
}
