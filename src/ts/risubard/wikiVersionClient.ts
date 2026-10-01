import { invokeBrowserFetch } from './browserFetch'
import { v4 as uuid } from 'uuid'
import { Buffer } from 'buffer'
import type { Chat } from '../storage/database.svelte'
import { encodeMemorySaveChat } from './memorySaveSlots'
import type {
    WikiAnchorMessage,
    WikiAnalysisReceiptResult,
    WikiChatAnchor,
    WikiCheckoutPreview,
    WikiCommitKind,
    WikiCommitProvenance,
    WikiHistoryEntry,
    WikiOperationReceipt,
    WikiRecoveryReason,
    WikiRefKind,
    WikiRefRecord,
} from './wikiVcsContract'
import { computeWikiPrefixDigests } from './wikiVcsContract'
import { canonicalTurnNeedsRetry, mergeCanonicalTurnReceipts, parseCanonicalTurnReceipt, type CanonicalTurnReceipt } from './canonicalTurnReceipt'

function prefixCheckpoints(messages: readonly WikiAnchorMessage[]) {
    const digests = computeWikiPrefixDigests(messages)
    return messages.map((message, index) => ({
        messageId: boundedId(message.messageId, 'Message ID'),
        prefixDigest: digests[index],
    }))
}

/**
 * Browser client for the BardWiki version store. Commit IDs and recovery ref
 * IDs always come from the server; nothing here invents history.
 */

interface Transport {
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedId(value: string, label: string): string {
    if (typeof value !== 'string'
        || value.trim().length === 0
        || value.length > 1_024) {
        throw new Error(`${label} must be a non-empty bounded ID`)
    }
    return value
}

async function failureDetail(response: Response): Promise<string> {
    const failure: unknown = await response.json().catch(() => undefined)
    return isRecord(failure) && typeof failure.error === 'string'
        && failure.error.length <= 1_000
        ? `: ${failure.error}`
        : ''
}

async function postJson<T>(
    transport: Transport,
    path: string,
    body: Record<string, unknown>,
    failureLabel: string
): Promise<T> {
    const response = await invokeBrowserFetch(transport.fetchImpl, path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            'content-type': 'application/json',
            'risu-auth': await transport.createAuth(),
        },
        body: JSON.stringify(body),
    })
    if (!response.ok) {
        throw new Error(
            `${failureLabel} failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    return await response.json() as T
}

function parseHistoryEntry(value: unknown): WikiHistoryEntry {
    if (!isRecord(value)
        || typeof value.commitId !== 'string'
        || (value.parent !== null && typeof value.parent !== 'string')
        || typeof value.createdAt !== 'string'
        || typeof value.onActiveBranch !== 'boolean'
        || !Array.isArray(value.changedPaths)) {
        throw new Error('Invalid wiki history entry')
    }
    return {
        commitId: value.commitId,
        parent: value.parent as string | null,
        kind: value.kind as WikiCommitKind,
        provenance: value.provenance as WikiCommitProvenance,
        createdAt: value.createdAt,
        boundaryMessageId: typeof value.boundaryMessageId === 'string'
            ? value.boundaryMessageId
            : null,
        sourceChatId: String(value.sourceChatId ?? ''),
        changedPaths: value.changedPaths.filter(
            (path): path is string => typeof path === 'string'
        ),
        exact: value.exact !== false,
        onActiveBranch: value.onActiveBranch,
    }
}

function parseRef(value: unknown): WikiRefRecord {
    if (!isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.commitId !== 'string'
        || typeof value.kind !== 'string') {
        throw new Error('Invalid wiki ref record')
    }
    return {
        schemaVersion: 1,
        kind: value.kind as WikiRefKind,
        id: value.id,
        commitId: value.commitId,
        characterId: String(value.characterId ?? ''),
        ...(typeof value.chatId === 'string' ? { chatId: value.chatId } : {}),
        ...(typeof value.chatStateRef === 'string'
            ? { chatStateRef: value.chatStateRef } : {}),
        ...(typeof value.label === 'string' ? { label: value.label } : {}),
        ...(typeof value.reason === 'string'
            ? { reason: value.reason as WikiRecoveryReason } : {}),
        createdAt: String(value.createdAt ?? ''),
    }
}

export interface WikiVersionClientInput extends Transport {
    characterId: string
    chatId: string
}

export async function ensureWikiVersion(
    input: WikiVersionClientInput & { chatAnchor?: WikiChatAnchor }
): Promise<{ created: boolean; commitId: string | null; branchId: string }> {
    const value = await postJson<Record<string, unknown>>(
        input,
        '/api/risubard/memory/wiki/version/ensure',
        {
            characterId: boundedId(input.characterId, 'Character ID'),
            chatId: boundedId(input.chatId, 'Chat ID'),
            ...(input.chatAnchor ? { chatAnchor: input.chatAnchor } : {}),
        },
        'Wiki version initialization'
    )
    return {
        created: value.created === true,
        commitId: typeof value.commitId === 'string' ? value.commitId : null,
        branchId: String(value.branchId ?? ''),
    }
}

export async function captureWikiVersion(
    input: WikiVersionClientInput & { poll?: boolean }
): Promise<{ commitId: string | null; changedPaths: string[] }> {
    const value = await postJson<Record<string, unknown>>(
        input,
        '/api/risubard/memory/wiki/version/capture',
        {
            characterId: boundedId(input.characterId, 'Character ID'),
            chatId: boundedId(input.chatId, 'Chat ID'),
            ...(input.poll === undefined ? {} : { poll: input.poll }),
        },
        'Wiki version capture'
    )
    return {
        commitId: typeof value.commitId === 'string' ? value.commitId : null,
        changedPaths: Array.isArray(value.changedPaths)
            ? value.changedPaths.filter(
                (path): path is string => typeof path === 'string'
            )
            : [],
    }
}

export async function listWikiHistory(
    input: WikiVersionClientInput
): Promise<WikiHistoryEntry[]> {
    const value = await postJson<unknown>(
        input,
        '/api/risubard/memory/wiki/version/history',
        {
            characterId: boundedId(input.characterId, 'Character ID'),
            chatId: boundedId(input.chatId, 'Chat ID'),
        },
        'Wiki history'
    )
    if (!Array.isArray(value)) throw new Error('Invalid wiki history response')
    return value.map(parseHistoryEntry)
}

export async function readWikiOperationResult(
    input: WikiVersionClientInput & { operationId: string },
): Promise<WikiOperationReceipt | null> {
    const value = await postJson<Record<string, unknown>>(
        input, '/api/risubard/memory/wiki/version/operation',
        { characterId: input.characterId, chatId: input.chatId, operationId: input.operationId },
        'Wiki operation result',
    )
    if (value.receipt === null) return null
    const receipt = value.receipt
    if (!isRecord(receipt) || receipt.schemaVersion !== 1 || receipt.status !== 'completed'
        || receipt.operationId !== input.operationId || receipt.characterId !== input.characterId
        || receipt.chatId !== input.chatId || typeof receipt.branchId !== 'string'
        || typeof receipt.commitId !== 'string'
        || !(receipt.previousHead === null || typeof receipt.previousHead === 'string')
        || !Array.isArray(receipt.changedPaths) || receipt.changedPaths.some(path => typeof path !== 'string')
        || typeof receipt.checkpointCreated !== 'boolean' || typeof receipt.createdAt !== 'string'
        || (receipt.recoveryRefId !== undefined && typeof receipt.recoveryRefId !== 'string')) {
        throw new Error('Invalid Wiki operation receipt')
    }
    return receipt as unknown as WikiOperationReceipt
}

export class WikiOperationOutcomeUnknownError extends Error {
    readonly operationId: string
    constructor(operationId: string, cause: unknown) {
        super(`Wiki operation outcome is unknown; operation ID: ${operationId}`, { cause })
        this.name = 'WikiOperationOutcomeUnknownError'
        this.operationId = operationId
    }
}

/** A lost/aborted response is not proof that the durable decision was cancelled. */
export async function recoverWikiOperationResult(
    input: WikiVersionClientInput & { operationId: string }, failure: unknown,
): Promise<WikiOperationReceipt> {
    let receipt: WikiOperationReceipt | null
    try { receipt = await readWikiOperationResult(input) }
    catch (error) { throw new WikiOperationOutcomeUnknownError(input.operationId, new AggregateError([failure, error])) }
    if (!receipt) throw failure
    return receipt
}

/** Reconciles the supplied detached snapshot with the target commit's ancestry. */
async function retainReachableReceipts(
    input: WikiVersionClientInput, chat: Chat, commitId: string,
): Promise<void> {
    const messageIds = new Set(chat.message.map(message => message.chatId))
    const retainsSource = (id: string) => {
        if (messageIds.has(id)) return true
        const greeting = /^first-message:.+:(-?\d+)$/u.exec(id)
        return !!greeting && !chat.firstMessageDisabled
            && Number(greeting[1]) === (chat.fmIndex ?? -1)
    }
    const wanted = new Set<string>()
    for (const message of chat.message) {
        const receipt = message.risubardCanonicalReceipt
        if (!receipt) continue
        if (!receipt.vcsCommitIds?.length) {
            delete message.risubardCanonicalReceipt
            message.risubardMemoryConfirmed = false
            continue
        }
        for (const id of receipt.vcsCommitIds) wanted.add(id)
    }
    if (!wanted.size) return
    const reachable = new Set<string>()
    const visited = new Set<string>()
    let cursor: string | null = commitId
    while (cursor && wanted.size) {
        if (visited.has(cursor)) throw new Error('Wiki commit history contains a cycle')
        visited.add(cursor)
        const page: { commitIds: string[]; nextCommitId: string | null } = await postJson(
            input, '/api/risubard/memory/wiki/version/ancestors',
            { characterId: input.characterId, chatId: input.chatId, commitId: cursor },
            'Wiki receipt ancestry',
        )
        if (!Array.isArray(page.commitIds)
            || page.commitIds.some(id => typeof id !== 'string')
            || (page.nextCommitId !== null && typeof page.nextCommitId !== 'string')) {
            throw new Error('Invalid wiki ancestry response')
        }
        for (const id of page.commitIds) {
            if (wanted.delete(id)) reachable.add(id)
        }
        cursor = page.nextCommitId
    }
    for (const message of chat.message) {
        const receipt = message.risubardCanonicalReceipt
        if (!receipt?.vcsCommitIds?.length) continue
        const retained = receipt.vcsCommitIds.filter(id => reachable.has(id))
        if (retained.length === receipt.vcsCommitIds.length
            && receipt.sourceMessageIds.every(retainsSource)) continue
        if (!retained.length) {
            delete message.risubardCanonicalReceipt
            message.risubardMemoryConfirmed = false
            continue
        }
        let restored: CanonicalTurnReceipt | undefined
        let complete = true
        for (const id of retained) {
            const result = await postJson<WikiAnalysisReceiptResult>(
                input, '/api/risubard/memory/wiki/version/analysis-receipt',
                { characterId: input.characterId, chatId: input.chatId, commitId: id },
                'Wiki analysis receipt',
            )
            if (!['commit', 'reconstructed'].includes(result.provenance)) {
                throw new Error('Invalid wiki analysis receipt provenance')
            }
            const part = parseCanonicalTurnReceipt(result.receipt)
            if (part.vcsCommitIds?.length !== 1 || part.vcsCommitIds[0] !== id) {
                throw new Error('Invalid wiki analysis receipt commit')
            }
            if (part.sourceMessageIds.some(source => !retainsSource(source))) continue
            if (result.provenance === 'reconstructed') complete = false
            restored = mergeCanonicalTurnReceipts(restored, part)
        }
        if (restored) {
            message.risubardCanonicalReceipt = restored
            message.risubardMemoryConfirmed = complete && !canonicalTurnNeedsRetry(restored)
        } else {
            delete message.risubardCanonicalReceipt
            message.risubardMemoryConfirmed = false
        }
    }
}

export async function previewWikiCheckout(
    input: WikiVersionClientInput & {
        commitId: string
        messages?: readonly WikiAnchorMessage[]
    }
): Promise<WikiCheckoutPreview> {
    const value = await postJson<Record<string, unknown>>(
        input,
        '/api/risubard/memory/wiki/version/preview',
        {
            characterId: boundedId(input.characterId, 'Character ID'),
            chatId: boundedId(input.chatId, 'Chat ID'),
            commitId: boundedId(input.commitId, 'Commit ID'),
            ...(input.messages ? { prefixes: prefixCheckpoints(input.messages) } : {}),
        },
        'Wiki checkout preview'
    )
    const anchor = value.chatAnchor
    if (!isRecord(anchor)
        || typeof anchor.sourceChatId !== 'string'
        || (anchor.boundaryMessageId !== null
            && typeof anchor.boundaryMessageId !== 'string')
        || typeof anchor.prefixDigest !== 'string'
        || typeof anchor.evidenceDigest !== 'string') {
        throw new Error('Invalid wiki checkout anchor')
    }
    return {
        commitId: String(value.commitId ?? ''),
        branchId: String(value.branchId ?? ''),
        exact: value.exact !== false,
        changedPaths: Array.isArray(value.changedPaths)
            ? value.changedPaths.filter(
                (path): path is string => typeof path === 'string'
            )
            : [],
        targetExists: value.targetExists === true,
        chatAnchor: {
            sourceChatId: boundedId(anchor.sourceChatId, 'Source chat ID'),
            boundaryMessageId: typeof anchor.boundaryMessageId === 'string'
                ? boundedId(anchor.boundaryMessageId, 'Boundary message ID') : null,
            prefixDigest: anchor.prefixDigest,
            evidenceDigest: anchor.evidenceDigest,
        },
    }
}

export async function checkoutWikiVersion(
    input: WikiVersionClientInput & {
        commitId: string
        reason?: WikiRecoveryReason
        chat: Chat
        expectedChatAnchor?: WikiChatAnchor
        operationId?: string
    }
): Promise<{
    branchId: string
    commitId: string
    previousHead: string | null
    changedPaths: string[]
    recoveryRefId: string | null
}> {
    await retainReachableReceipts(input, input.chat, input.commitId)
    const operationId = input.operationId ?? `checkout:${uuid()}`
    let value: Record<string, unknown> | WikiOperationReceipt
    try {
    value = await postJson<Record<string, unknown>>(
        input,
        '/api/risubard/memory/wiki/version/checkout',
        {
            characterId: boundedId(input.characterId, 'Character ID'),
            chatId: boundedId(input.chatId, 'Chat ID'),
            commitId: boundedId(input.commitId, 'Commit ID'),
            ...(input.reason ? { reason: input.reason } : {}),
            operationId,
            chatBase64: Buffer.from(encodeMemorySaveChat(input.chat)).toString('base64'),
            ...(input.expectedChatAnchor ? { expectedChatAnchor: input.expectedChatAnchor } : {}),
        },
        'Wiki checkout'
    )
    }
    catch (error) { value = await recoverWikiOperationResult({ ...input, operationId }, error) }
    return {
        branchId: String(value.branchId ?? ''),
        commitId: String(value.commitId ?? ''),
        previousHead: typeof value.previousHead === 'string'
            ? value.previousHead
            : null,
        changedPaths: Array.isArray(value.changedPaths)
            ? value.changedPaths.filter(
                (path): path is string => typeof path === 'string'
            )
            : [],
        recoveryRefId: typeof value.recoveryRefId === 'string'
            ? value.recoveryRefId
            : null,
    }
}

export async function forkWikiVersion(
    input: {
        characterId: string
        sourceChatId: string
        destinationChatId: string
        commitId: string
        chat: Chat
        operationId?: string
        fetchImpl: typeof fetch
        createAuth(): Promise<string>
    }
): Promise<{ branchId: string; commitId: string; changedPaths: string[] }> {
    await retainReachableReceipts({ ...input, chatId: input.sourceChatId }, input.chat, input.commitId)
    const operationId = input.operationId ?? `fork:${uuid()}`
    let value: Record<string, unknown> | WikiOperationReceipt
    try {
    value = await postJson<Record<string, unknown>>(
        input,
        '/api/risubard/memory/wiki/version/fork',
        {
            characterId: boundedId(input.characterId, 'Character ID'),
            sourceChatId: boundedId(input.sourceChatId, 'Source chat ID'),
            destinationChatId: boundedId(
                input.destinationChatId, 'Destination chat ID'
            ),
            commitId: boundedId(input.commitId, 'Commit ID'),
            operationId,
            chatBase64: Buffer.from(encodeMemorySaveChat(input.chat)).toString('base64'),
        },
        'Wiki fork'
    )
    }
    catch (error) {
        value = await recoverWikiOperationResult({ ...input, chatId: input.destinationChatId, operationId }, error)
    }
    return {
        branchId: String(value.branchId ?? ''),
        commitId: String(value.commitId ?? ''),
        changedPaths: Array.isArray(value.changedPaths)
            ? value.changedPaths.filter(
                (path): path is string => typeof path === 'string'
            )
            : [],
    }
}

export async function listWikiRefs(
    input: WikiVersionClientInput & { kind?: WikiRefKind }
): Promise<WikiRefRecord[] | {
    recovery: WikiRefRecord[]
    autosave: WikiRefRecord[]
    save: WikiRefRecord[]
}> {
    const value = await postJson<unknown>(
        input,
        '/api/risubard/memory/wiki/version/refs',
        {
            characterId: boundedId(input.characterId, 'Character ID'),
            chatId: boundedId(input.chatId, 'Chat ID'),
            ...(input.kind ? { kind: input.kind } : {}),
        },
        'Wiki refs'
    )
    if (Array.isArray(value)) return value.map(parseRef)
    if (!isRecord(value)) throw new Error('Invalid wiki refs response')
    const group = (key: WikiRefKind): WikiRefRecord[] =>
        Array.isArray(value[key])
            ? (value[key] as unknown[]).map(parseRef)
            : []
    return {
        recovery: group('recovery'),
        autosave: group('autosave'),
        save: group('save'),
    }
}

export async function deleteWikiRef(
    input: WikiVersionClientInput & { kind: WikiRefKind; id: string }
): Promise<void> {
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/wiki/version/ref/delete',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify({
                characterId: boundedId(input.characterId, 'Character ID'),
                chatId: boundedId(input.chatId, 'Chat ID'),
                kind: input.kind,
                id: boundedId(input.id, 'Ref ID'),
            }),
        }
    )
    if (!response.ok) {
        throw new Error(
            `Wiki ref deletion failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
}

/**
 * Resolves the latest recorded wiki state compatible with the remaining prefix.
 * A confirmed boundary floor prevents silently skipping an unrecorded batch.
 */
export async function findWikiCommitForPrefix(
    input: WikiVersionClientInput & {
        messages: readonly WikiAnchorMessage[]
        minimumBoundaryMessageId?: string | null
    }
): Promise<string | null> {
    const value = await postJson<Record<string, unknown>>(
        input,
        '/api/risubard/memory/wiki/version/prefix',
        {
            characterId: boundedId(input.characterId, 'Character ID'),
            chatId: boundedId(input.chatId, 'Chat ID'),
            ...(input.minimumBoundaryMessageId === undefined ? {} : {
                minimumBoundaryMessageId: input.minimumBoundaryMessageId === null
                    ? null : boundedId(input.minimumBoundaryMessageId, 'Minimum boundary ID'),
            }),
            prefixes: prefixCheckpoints(input.messages),
        },
        'Wiki prefix lookup'
    )
    return typeof value.commitId === 'string' ? value.commitId : null
}

export async function createWikiRecovery(
    input: WikiVersionClientInput & {
        commitId: string
        reason: WikiRecoveryReason
        chatBase64: string
    }
): Promise<string> {
    const result = await postJson<{ id: string }>(
        input,
        '/api/risubard/memory/wiki/version/ref',
        {
            characterId: input.characterId,
            chatId: input.chatId,
            commitId: input.commitId,
            kind: 'recovery',
            reason: input.reason,
            chatBase64: input.chatBase64,
        },
        'Wiki recovery preservation'
    )
    return boundedId(result.id, 'Recovery ref ID')
}

export async function readWikiRecovery(
    input: WikiVersionClientInput & { id: string }
): Promise<{ ref: WikiRefRecord; chatBase64: string }> {
    const result = await postJson<{ ref: unknown; chatBase64: string }>(
        input,
        '/api/risubard/memory/wiki/version/recovery/read',
        { characterId: input.characterId, chatId: input.chatId, id: input.id },
        'Wiki recovery read'
    )
    return { ref: parseRef(result.ref), chatBase64: result.chatBase64 }
}

export async function listDeletedWikiRecovery(
    input: Transport & { characterId: string }
): Promise<WikiRefRecord[]> {
    const result = await postJson<unknown>(
        input,
        '/api/risubard/memory/wiki/version/recovery/deleted',
        { characterId: input.characterId },
        'Deleted chat recovery'
    )
    if (!Array.isArray(result)) throw new Error('Invalid deleted recovery response')
    return result.map(parseRef)
}

export async function discardWikiFork(input: WikiVersionClientInput): Promise<void> {
    await postJson(input, '/api/risubard/memory/wiki/version/fork/discard',
        { characterId: input.characterId, chatId: input.chatId },
        'Wiki fork discard')
}
