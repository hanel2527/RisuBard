import { randomUUID } from 'node:crypto'
import {
    computeWikiPrefixDigests,
    type WikiAnchorMessage,
    type WikiChatAnchor,
    type WikiCheckoutPreview,
    type WikiCommitKind,
    type WikiHistoryEntry,
    type WikiPrefixCheckpoint,
    type WikiPublishChangesRequest,
    type WikiPublishChangesResult,
    type WikiRecoveryReason,
    type WikiRefKind,
    type WikiRefRecord,
} from '../../src/ts/risubard/wikiVcsContract'
import {
    createWikiVcsRepository,
    type WikiVcsService,
    type WikiVcsServiceOptions,
} from './risubard-wiki-vcs'

export interface WikiVersioningOptions extends WikiVcsServiceOptions {
    /** Resolves the live chat boundary for a chat, when the caller has none. */
    loadChatAnchor?: (
        characterId: string,
        chatId: string
    ) => Promise<WikiChatAnchor | undefined>
    /**
     * Rejects a publication when the canonical chat no longer matches the
     * evidence prefix that produced it.
     */
    validateChatAnchor?: (
        expected: WikiChatAnchor,
        current: WikiChatAnchor,
        characterId: string
    ) => boolean
}

/**
 * The subset of versioning the Markdown wiki needs: report writes, publish
 * sparse batches, read snapshots and move branches.
 */
export interface WikiVersioningPort {
    afterWrite(input: {
        characterId: string
        chatId: string
        kind: WikiCommitKind
        operationId?: string
        chatAnchor?: WikiChatAnchor
        expectedHead?: string | null
    }): Promise<{ commitId: string | null; changedPaths: string[] }>
    publishChanges(input: WikiPublishChangesRequest): Promise<WikiPublishChangesResult>
    captureExternalChanges(input: {
        characterId: string
        chatId: string
        chatAnchor?: WikiChatAnchor
    }): Promise<{ commitId: string | null; changedPaths: string[] }>
    ensureBaseline(input: {
        characterId: string
        chatId: string
        chatAnchor?: WikiChatAnchor
        operationId?: string
    }): Promise<{ created: boolean; commitId: string | null; branchId: string }>
    validatePublication(input: {
        characterId: string
        chatId: string
        chatAnchor?: WikiChatAnchor
        expectedHead?: string | null
    }): Promise<void>
    readHead(characterId: string, chatId: string): Promise<string | null>
    readPathMap(
        characterId: string,
        chatId: string,
        commitId: string
    ): Promise<Record<string, string>>
    checkout(input: {
        characterId: string
        chatId: string
        commitId: string
        reason?: WikiRecoveryReason
        chatAnchor?: WikiChatAnchor
    }): Promise<{
        branchId: string
        commitId: string
        previousHead: string | null
        changedPaths: string[]
        recoveryRefId: string | null
        preservedExternalCommitId: string | null
    }>
}

/** `afterWrite` alone is enough for write-only callers. */
export type WikiVersioningHooks = Pick<WikiVersioningPort, 'afterWrite'>

export interface WikiVersioningService extends WikiVersioningPort {
    captureExternalChanges(input: {
        characterId: string
        chatId: string
        chatAnchor?: WikiChatAnchor
    }): Promise<{ commitId: string | null; changedPaths: string[] }>
    previewCheckout(input: {
        characterId: string
        chatId: string
        commitId: string
        messages?: readonly WikiAnchorMessage[]
        prefixes?: readonly WikiPrefixCheckpoint[]
    }): Promise<WikiCheckoutPreview>
    /**
     * Preserves uncommitted on-disk edits as a commit and then moves the branch
     * to the requested commit. The previous head survives as a recovery ref.
     */
    checkout(input: {
        characterId: string
        chatId: string
        commitId: string
        reason?: WikiRecoveryReason
        chatAnchor?: WikiChatAnchor
    }): Promise<{
        branchId: string
        commitId: string
        previousHead: string | null
        changedPaths: string[]
        recoveryRefId: string | null
        preservedExternalCommitId: string | null
    }>
    fork(input: {
        characterId: string
        sourceChatId: string
        destinationChatId: string
        commitId: string
        chatAnchor?: WikiChatAnchor
    }): Promise<{ branchId: string; commitId: string; changedPaths: string[] }>
    /** Commit matching an ordered chat prefix, or null when history cannot. */
    findCommitForPrefix(input: {
        characterId: string
        chatId: string
        messages: readonly WikiAnchorMessage[]
        minimumBoundaryMessageId?: string | null
    }): Promise<string | null>
    findCommitForPrefixes(input: {
        characterId: string
        chatId: string
        prefixes: readonly WikiPrefixCheckpoint[]
        minimumBoundaryMessageId?: string | null
    }): Promise<string | null>
    /** Finishes commits interrupted mid-publish, then reports what happened. */
    recoverOperations(input: {
        characterId: string
        chatId: string
    }): Promise<{
        completed: string[]
        discarded: string[]
        unresolved: string[]
    }>
    listHistory(input: {
        characterId: string
        chatId: string
        limit?: number
    }): Promise<WikiHistoryEntry[]>
    listRefs(input: {
        characterId: string
        chatId: string
        kind: WikiRefKind
    }): Promise<WikiRefRecord[]>
    createRef(input: {
        characterId: string
        chatId?: string
        chatStateRef?: string
        commitId: string
        kind: WikiRefKind
        reason?: WikiRecoveryReason
        label?: string
        id?: string
    }): Promise<string>
    deleteRef(input: {
        characterId: string
        chatId: string
        kind: WikiRefKind
        id: string
    }): Promise<void>
    readPathMap(
        characterId: string,
        chatId: string,
        commitId: string
    ): Promise<Record<string, string>>
    listRefsForChat(characterId: string, chatId: string): Promise<{
        recovery: WikiRefRecord[]
        autosave: WikiRefRecord[]
        save: WikiRefRecord[]
    }>
}

/** Chat-agnostic fallback: the commit records the chat, not a boundary. */
export function anchorlessChatAnchor(chatId: string): WikiChatAnchor {
    return {
        sourceChatId: chatId,
        boundaryMessageId: null,
        prefixDigest: '',
        evidenceDigest: '',
    }
}

export function createWikiVersioning(
    userDataDirectory: string,
    options: WikiVersioningOptions = {}
): WikiVersioningService {
    const repository: WikiVcsService = createWikiVcsRepository(
        userDataDirectory, options
    )
    const loadChatAnchor = options.loadChatAnchor

    const resolveAnchor = async (
        characterId: string,
        chatId: string,
        provided?: WikiChatAnchor
    ): Promise<WikiChatAnchor> => provided
        ?? await loadChatAnchor?.(characterId, chatId)
        ?? anchorlessChatAnchor(chatId)

    const assertCurrentAnchor = async (
        characterId: string,
        chatId: string,
        expected?: WikiChatAnchor
    ): Promise<void> => {
        if (!expected || !loadChatAnchor) return
        const current = await loadChatAnchor(
            characterId, expected.sourceChatId
        )
        if (!current) return
        const valid = options.validateChatAnchor
            ? options.validateChatAnchor(expected, current, characterId)
            : expected.sourceChatId === current.sourceChatId
                && expected.boundaryMessageId === current.boundaryMessageId
                && expected.prefixDigest === current.prefixDigest
        if (!valid) {
            throw new Error(
                'Wiki chat conflict: the persisted chat changed during publication'
            )
        }
    }

    const afterWrite: WikiVersioningHooks['afterWrite'] = async (input) => {
        const anchor = await resolveAnchor(
            input.characterId, input.chatId, input.chatAnchor
        )
        await assertCurrentAnchor(
            input.characterId, input.chatId, input.chatAnchor
        )
        const operationId = input.operationId ?? newWikiOperationId(input.kind)
        try {
            return await repository.captureExternalChanges({
                characterId: input.characterId,
                chatId: input.chatId,
                chatAnchor: anchor,
                kind: input.kind,
                operationId,
                ...(input.expectedHead !== undefined
                    ? { expectedHead: input.expectedHead } : {}),
            })
        }
        catch (error) {
            const branch = await repository.ensureRepository(
                input.characterId, input.chatId
            )
            const published = branch.head
                ? await repository.readCommit(input.characterId, input.chatId, branch.head)
                : undefined
            if (published?.operationId === operationId) {
                await repository.recoverOperations({
                    characterId: input.characterId, chatId: input.chatId,
                })
                return {
                    commitId: published.id,
                    changedPaths: published.changes.map((change) => change.path),
                }
            }
            await repository.discardUnpublishedOperation({
                characterId: input.characterId, chatId: input.chatId, operationId,
            })
            throw error
        }
    }

    return {
        afterWrite,
        async publishChanges(input) {
            const anchor = await resolveAnchor(
                input.characterId, input.chatId, input.chatAnchor
            )
            await assertCurrentAnchor(
                input.characterId, input.chatId, input.chatAnchor
            )
            return repository.publishChanges({
                ...input,
                chatAnchor: anchor,
            })
        },
        async validatePublication(input) {
            await assertCurrentAnchor(
                input.characterId, input.chatId, input.chatAnchor
            )
            if (input.expectedHead !== undefined) {
                const currentHead = await repository.ensureRepository(
                    input.characterId, input.chatId
                )
                if (currentHead.head !== input.expectedHead) {
                    throw new Error(
                        'Wiki commit conflict: the branch head changed'
                    )
                }
            }
        },

        async readHead(characterId, chatId) {
            const repositoryState = await repository.ensureRepository(
                characterId, chatId
            )
            return repositoryState.head
        },

        async ensureBaseline(input) {
            const anchor = await resolveAnchor(
                input.characterId, input.chatId, input.chatAnchor
            )
            await assertCurrentAnchor(
                input.characterId, input.chatId, input.chatAnchor
            )
            return repository.ensureBaseline({
                characterId: input.characterId,
                chatId: input.chatId,
                chatAnchor: anchor,
                ...(input.operationId ? { operationId: input.operationId } : {}),
            })
        },

        async captureExternalChanges(input) {
            const anchor = await resolveAnchor(
                input.characterId, input.chatId, input.chatAnchor
            )
            return repository.captureExternalChanges({
                characterId: input.characterId,
                chatId: input.chatId,
                chatAnchor: anchor,
            })
        },

        async previewCheckout(input) {
            return repository.previewCheckout(input)
        },

        async checkout(input) {
            const anchor = await resolveAnchor(
                input.characterId, input.chatId, input.chatAnchor
            )
            // Uncommitted external edits must survive the rewind, so they are
            // committed first instead of being overwritten.
            const preserved = await repository.captureExternalChanges({
                characterId: input.characterId,
                chatId: input.chatId,
                chatAnchor: anchor,
            })
            const result = await repository.checkout({
                characterId: input.characterId,
                chatId: input.chatId,
                commitId: input.commitId,
                ...(input.reason ? { reason: input.reason } : {}),
                chatAnchor: anchor,
            })
            return {
                ...result,
                preservedExternalCommitId: preserved.commitId,
            }
        },

        async fork(input) {
            const anchor = await resolveAnchor(
                input.characterId, input.sourceChatId, input.chatAnchor
            )
            await repository.captureExternalChanges({
                characterId: input.characterId,
                chatId: input.sourceChatId,
                chatAnchor: anchor,
            })
            return repository.fork({
                characterId: input.characterId,
                sourceChatId: input.sourceChatId,
                destinationChatId: input.destinationChatId,
                commitId: input.commitId,
            })
        },

        async findCommitForPrefix(input) {
            const digests = computeWikiPrefixDigests(input.messages)
            const prefixes = input.messages.map((message, index) => ({
                messageId: message.messageId,
                prefixDigest: digests[index],
            }))
            return repository.findCommitForPrefixes({
                characterId: input.characterId,
                chatId: input.chatId,
                prefixes,
                ...(input.minimumBoundaryMessageId !== undefined
                    ? { minimumBoundaryMessageId: input.minimumBoundaryMessageId }
                    : {}),
            })
        },

        async findCommitForPrefixes(input) {
            return repository.findCommitForPrefixes(input)
        },


        async recoverOperations(input) {
            return repository.recoverOperations(input)
        },

        async listHistory(input) {
            return repository.listHistory(input)
        },

        async listRefs(input) {
            return repository.listRefs(input)
        },

        async createRef(input) {
            return repository.createRef(input)
        },

        async deleteRef(input) {
            return repository.deleteRef(input)
        },

        async readPathMap(characterId, chatId, commitId) {
            return repository.readPathMap(characterId, chatId, commitId)
        },

        async listRefsForChat(characterId, chatId) {
            const [recovery, autosave, save] = await Promise.all([
                repository.listRefs({ characterId, chatId, kind: 'recovery' }),
                repository.listRefs({ characterId, chatId, kind: 'autosave' }),
                repository.listRefs({ characterId, chatId, kind: 'save' }),
            ])
            return { recovery, autosave, save }
        },
    }
}

/**
 * New operation IDs are generated here rather than by callers so a retried
 * request cannot silently create a second commit for one logical write.
 */
export function newWikiOperationId(prefix: string): string {
    return `${prefix}:${randomUUID()}`
}
