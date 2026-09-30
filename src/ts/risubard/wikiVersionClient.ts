import { invokeBrowserFetch } from './browserFetch'
import type {
    WikiAnchorMessage,
    WikiChatAnchor,
    WikiCheckoutPreview,
    WikiCommitKind,
    WikiCommitProvenance,
    WikiHistoryEntry,
    WikiRecoveryReason,
    WikiRefKind,
    WikiRefRecord,
} from './wikiVcsContract'
import { computeWikiPrefixDigests } from './wikiVcsContract'

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
    input: WikiVersionClientInput
): Promise<{ commitId: string | null; changedPaths: string[] }> {
    const value = await postJson<Record<string, unknown>>(
        input,
        '/api/risubard/memory/wiki/version/capture',
        {
            characterId: boundedId(input.characterId, 'Character ID'),
            chatId: boundedId(input.chatId, 'Chat ID'),
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
    }
): Promise<{
    branchId: string
    commitId: string
    previousHead: string | null
    changedPaths: string[]
    recoveryRefId: string | null
}> {
    const value = await postJson<Record<string, unknown>>(
        input,
        '/api/risubard/memory/wiki/version/checkout',
        {
            characterId: boundedId(input.characterId, 'Character ID'),
            chatId: boundedId(input.chatId, 'Chat ID'),
            commitId: boundedId(input.commitId, 'Commit ID'),
            ...(input.reason ? { reason: input.reason } : {}),
        },
        'Wiki checkout'
    )
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
        fetchImpl: typeof fetch
        createAuth(): Promise<string>
    }
): Promise<{ branchId: string; commitId: string; changedPaths: string[] }> {
    const value = await postJson<Record<string, unknown>>(
        input,
        '/api/risubard/memory/wiki/version/fork',
        {
            characterId: boundedId(input.characterId, 'Character ID'),
            sourceChatId: boundedId(input.sourceChatId, 'Source chat ID'),
            destinationChatId: boundedId(
                input.destinationChatId, 'Destination chat ID'
            ),
            commitId: boundedId(input.commitId, 'Commit ID'),
        },
        'Wiki fork'
    )
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
