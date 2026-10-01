/**
 * Shared contract between the BardWiki version store (server) and the chat
 * client. This module must stay dependency-free so both runtimes can import it.
 *
 * Blob and commit identities are SHA-256 and live on the server. Chat anchors
 * only need stable identity comparison, so they use a compact 64-bit FNV-1a
 * digest that both runtimes can compute without a crypto library.
 */

export const WIKI_VCS_SCHEMA_VERSION = 1 as const

export type WikiCommitKind =
    | 'baseline'
    | 'analysis'
    | 'manual'
    | 'admin'
    | 'external'
    | 'rebuild'
    | 'import'
    | 'review'
    | 'policy'

export type WikiCommitProvenance = 'recorded' | 'legacy-baseline' | 'reconstructed'

export interface WikiCommitChange {
    /** Repository-relative path, always using `/` separators. */
    path: string
    /** Blob hash before the change, or null when the path did not exist. */
    before: string | null
    /** Blob hash after the change, or null when the path was deleted. */
    after: string | null
}

export interface WikiChatAnchor {
    sourceChatId: string
    /** Message boundary the wiki state belongs to, or null for a chat head. */
    boundaryMessageId: string | null
    /** Digest of the ordered chat prefix covered by this commit. */
    prefixDigest: string
    /** Digest of the normalized analysis evidence used by this commit. */
    evidenceDigest: string
}

export interface WikiCommitRecord {
    schemaVersion: 1
    id: string
    parent: string | null
    operationId: string
    kind: WikiCommitKind
    changes: WikiCommitChange[]
    chatAnchor: WikiChatAnchor
    analysisReceiptRef?: string
    provenance: WikiCommitProvenance
    createdAt: string
}

export interface WikiBranchRecord {
    schemaVersion: 1
    id: string
    characterId: string
    chatId: string
    head: string | null
    parentBranchId?: string
    createdAt: string
    updatedAt: string
}

export interface WikiCheckpointRecord {
    schemaVersion: 1
    /** Commit this checkpoint describes. */
    commitId: string
    /** Complete path -> blob hash map at `commitId`. */
    paths: Record<string, string>
    createdAt: string
}

export type WikiRefKind = 'save' | 'recovery' | 'autosave'

export interface WikiRefRecord {
    schemaVersion: 1
    kind: WikiRefKind
    id: string
    commitId: string
    characterId: string
    chatId?: string
    chatStateRef?: string
    label?: string
    reason?: WikiRecoveryReason
    createdAt: string
}

export type WikiRecoveryReason =
    | 'truncate'
    | 'reroll'
    | 'chat-delete'
    | 'save-load'
    | 'reboot'
    | 'purge-restore'
    | 'fork'

/** Chat -> working tree link written next to the Markdown workspace. */
export interface WikiChatLink {
    schemaVersion: 1
    characterId: string
    chatId: string
    branchId: string
    /** Commit the working tree was last materialized from. */
    materializedCommitId: string | null
    /** Revision of the committed path map last materialized by the app. */
    materializedRevision: string
    originChatId?: string
    updatedAt: string
}

export interface WikiHistoryEntry {
    commitId: string
    parent: string | null
    kind: WikiCommitKind
    provenance: WikiCommitProvenance
    createdAt: string
    boundaryMessageId: string | null
    sourceChatId: string
    changedPaths: string[]
    /** True when this commit can be materialized exactly by checkout. */
    exact: boolean
    /** True when this commit's boundaries match the chat the caller asked about. */
    onActiveBranch: boolean
}

export interface WikiCheckoutPreview {
    commitId: string
    branchId: string
    exact: boolean
    chatAnchor: WikiChatAnchor
    changedPaths: string[]
    targetExists: boolean
}

export interface WikiOperationReceipt {
    schemaVersion: 1
    operationId: string
    status: 'completed'
    branchId: string
    chatId: string
    characterId: string
    commitId: string
    previousHead: string | null
    changedPaths: string[]
    checkpointCreated: boolean
    createdAt: string
    recoveryRefId?: string
}

export interface WikiCommitRequest {
    characterId: string
    chatId: string
    operationId: string
    expectedHead: string | null
    kind: WikiCommitKind
    provenance?: WikiCommitProvenance
    chatAnchor: WikiChatAnchor
    analysisReceiptRef?: string
    changes: Array<{ path: string; contents: string | null }>
}
export interface WikiPublishChangesRequest {
    characterId: string
    chatId: string
    operationId: string
    kind: WikiCommitKind
    chatAnchor?: WikiChatAnchor
    expectedHead: string | null
    changes: Array<{ path: string; contents: string | null }>
}

export interface WikiPublishChangesResult {
    commitId: string | null
    changedPaths: string[]
}


export interface WikiCheckoutRequest {
    characterId: string
    chatId: string
    commitId: string
    operationId: string
    /** Canonical chat snapshot published under the wiki journal's decision. */
    chatBase64: string
    expectedChatAnchor?: WikiChatAnchor
    reason?: WikiRecoveryReason
}

export interface WikiForkRequest {
    characterId: string
    sourceChatId: string
    destinationChatId: string
    commitId: string
}

export interface WikiRecoveryRefSummary {
    id: string
    commitId: string
    chatId?: string
    reason?: WikiRecoveryReason
    label?: string
    createdAt: string
    headMessageId: string | null
    changedPaths: string[]
}

/** Root-level paths that are never part of the versioned set. */
export const WIKI_VCS_EXCLUDED_DIRECTORIES = [
    '.risubard-history',
    '.risubard-trash',
    '.risubard-snapshots',
    '.risubard-recovery',
    '.risubard-fork',
] as const

export const WIKI_VCS_EXCLUDED_FILES = ['index.md'] as const

export function normalizeWikiVcsPath(value: string): string {
    const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!normalized || normalized.startsWith('/')
        || normalized.includes('\0')
        || normalized.split('/').some((segment) =>
            segment === '' || segment === '.' || segment === '..')) {
        throw new Error(`Invalid wiki path: ${value}`)
    }
    return normalized
}

/**
 * `index.md` is regenerated from the documents and the legacy per-document
 * history/trash directories keep their own older contract. Everything else
 * ending in `.md` is versioned, including review baselines.
 */
export function isWikiVcsTrackedPath(relativePath: string): boolean {
    let normalized: string
    try {
        normalized = normalizeWikiVcsPath(relativePath)
    }
    catch {
        return false
    }
    if (!normalized.endsWith('.md')) return false
    if ((WIKI_VCS_EXCLUDED_FILES as readonly string[]).includes(normalized)) {
        return false
    }
    return !(WIKI_VCS_EXCLUDED_DIRECTORIES as readonly string[])
        .some((directory) => normalized.startsWith(`${directory}/`))
}

function updateFNV(input: string, low: number, high: number): [number, number] {
    const bytes = new TextEncoder().encode(input)
    for (const byte of bytes) {
        low ^= byte
        high ^= byte
        low = Math.imul(low, 0x01000193) >>> 0
        high = Math.imul(high, 0x85ebca6b) >>> 0
    }
    return [low, high]
}

function finishFNV(low: number, high: number): string {
    const mixed = (Math.imul(high ^ (high >>> 15), 0x2545f491) >>> 0)
    return `${mixed.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`
}

function fnv1a64(input: string): string {
    return finishFNV(...updateFNV(input, 0xcbf29ce4, 0x84222325))
}

export interface WikiAnchorMessage {
    /** Stable message identity. Missing IDs are treated as unstable input. */
    messageId: string
    role: string
    data: string
    disabled?: boolean | string
    isComment?: boolean
}

export interface WikiPrefixCheckpoint {
    messageId: string
    prefixDigest: string
}

function messageDigest(parts: readonly (string | boolean | null | undefined)[
]): string {
    return fnv1a64(parts.map((part) =>
        part === undefined || part === null ? '' : String(part)).join('\u0001'))
}

/**
 * Digest of the ordered chat prefix covered by a committed wiki state. Any
 * content, ordering, flag or selected-swipe change invalidates it.
 */
export function computeWikiPrefixDigest(
    messages: readonly WikiAnchorMessage[]
): string {
    const parts: string[] = []
    for (const message of messages) {
        parts.push(messageDigest([
            message.messageId,
            message.role,
            messageDigest([message.data]),
            message.disabled === undefined ? '' : String(message.disabled),
            message.isComment === true ? 'comment' : '',
        ]))
    }
    return fnv1a64(parts.join('\u0002'))
}

/** Prefix digests in one pass, used to validate every dependency in history. */
export function computeWikiPrefixDigests(
    messages: readonly WikiAnchorMessage[]
): string[] {
    const digests: string[] = []
    let low = 0xcbf29ce4
    let high = 0x84222325
    for (let index = 0; index < messages.length; index += 1) {
        if (index > 0) {
            [low, high] = updateFNV('\u0002', low, high)
        }
        const message = messages[index]
        const current = messageDigest([
            message.messageId,
            message.role,
            messageDigest([message.data]),
            message.disabled === undefined ? '' : String(message.disabled),
            message.isComment === true ? 'comment' : '',
        ])
        const next = updateFNV(current, low, high)
        low = next[0]
        high = next[1]
        digests.push(finishFNV(low, high))
    }
    return digests
}

/** Digest of the normalized evidence actually handed to the writer. */
export function computeWikiEvidenceDigest(
    evidence: readonly WikiAnchorMessage[]
): string {
    const parts: string[] = []
    for (const message of evidence) {
        parts.push(messageDigest([
            message.messageId,
            message.role,
            messageDigest([message.data]),
        ]))
    }
    return fnv1a64(parts.join('\u0003'))
}

export function chatBoundaryAnchor(
    sourceChatId: string,
    boundaryMessageId: string | null,
    messages: readonly WikiAnchorMessage[],
    evidence: readonly WikiAnchorMessage[] = messages
): WikiChatAnchor {
    return {
        sourceChatId,
        boundaryMessageId,
        prefixDigest: computeWikiPrefixDigest(messages),
        evidenceDigest: computeWikiEvidenceDigest(evidence),
    }
}

/** Commit kinds that may move the branch head without new evidence. */
export function isWikiVcsHistoryKind(kind: WikiCommitKind): boolean {
    return kind !== 'external'
}
