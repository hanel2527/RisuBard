import type { Chat, Message } from '../storage/database.svelte'
import {
    chatBoundaryAnchor,
    type WikiAnchorMessage,
} from './wikiVcsContract'
import {
    checkoutWikiVersion,
    ensureWikiVersion,
    findWikiCommitForPrefix,
    forkWikiVersion,
    previewWikiCheckout,
} from './wikiVersionClient'
import { createWikiRecovery, captureWikiVersion, listWikiHistory } from './wikiVersionClient'
import { encodeMemorySaveChat } from './memorySaveSlots'
import { Buffer } from 'buffer'
import type { WikiRecoveryReason } from './wikiVcsContract'
import { announceRisuBardMemoryUpdated } from './memoryEvents'
import { requestImmediateSave } from '../globalApi.svelte'

/**
 * Chat-side coordinator for the BardWiki version store. Chat mutations that
 * invalidate committed wiki state (truncation, single-message deletion, reroll,
 * point-in-chat fork) resolve their target through this module so the wiki and
 * the chat never disagree about the story's current point.
 */

export interface WikiChatContext {
    characterId: string
    chatId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}

function clientInput(context: WikiChatContext) {
    return {
        characterId: context.characterId,
        chatId: context.chatId,
        fetchImpl: context.fetchImpl,
        createAuth: context.createAuth,
    }
}

/** Messages that carry a stable identity and can anchor wiki history. */
export function anchorMessagesFromChat(messages: readonly Message[]): WikiAnchorMessage[] {
    const anchors: WikiAnchorMessage[] = []
    for (const message of messages) {
        if (!message || typeof message !== 'object') continue
        if (typeof message.chatId !== 'string' || message.chatId.length === 0) {
            continue
        }
        anchors.push({
            messageId: message.chatId,
            role: message.role === 'user' ? 'user' : 'assistant',
            data: typeof message.data === 'string' ? message.data : '',
            ...(message.disabled === undefined
                ? {} : { disabled: message.disabled }),
            ...(message.isComment === true ? { isComment: true } : {}),
        })
    }
    return anchors
}

/** Prefix digest for the messages that remain after a chat edit. */
export function chatPrefixDigest(messages: readonly Message[]): string {
    return chatBoundaryAnchor(
        'chat', null, anchorMessagesFromChat(messages)
    ).prefixDigest
}

export interface WikiRollbackPlan {
    /** Commit to check out, or null when the prefix was never recorded. */
    commitId: string | null
    /** True when the caller must rebuild the wiki from the chat instead. */
    requiresRebuild: boolean
    exact: boolean
    changedPaths: string[]
}

function latestConfirmedBoundary(messages: readonly Message[]): string | null {
    const message = messages.findLast((item) =>
        item.role === 'char' && !item.disabled && !item.isComment
        && (item.risubardMemoryConfirmed === true
            || item.risubardCanonicalReceipt !== undefined)
    )
    return message?.chatId ?? null
}

/**
 * Resolves the wiki state for the chat prefix that would remain after an edit.
 * `requiresRebuild` means the prefix predates recorded history, so the caller
 * must not pretend the current wiki matches it.
 */
export async function planWikiRollback(
    context: WikiChatContext,
    remainingMessages: readonly Message[]
): Promise<WikiRollbackPlan> {
    const client = clientInput(context)
    await ensureWikiVersion(client)
    const anchors = anchorMessagesFromChat(remainingMessages)
    const commitId = await findWikiCommitForPrefix({
        ...client,
        messages: anchors,
        minimumBoundaryMessageId: latestConfirmedBoundary(remainingMessages),
    })
    if (!commitId) {
        return {
            commitId: null,
            requiresRebuild: true,
            exact: false,
            changedPaths: [],
        }
    }
    const preview = await previewWikiCheckout({
        ...client, commitId, messages: anchors,
    })
    return {
        commitId,
        requiresRebuild: !preview.exact,
        exact: preview.exact,
        changedPaths: preview.changedPaths,
    }
}

/**
 * Moves the wiki to match an already-changed chat. The previous head is kept as
 * a recovery ref by the server, so the replaced future stays recoverable.
 */
export async function applyWikiRollback(
    context: WikiChatContext,
    remainingMessages: readonly Message[],
    reason: 'truncate' | 'reroll'
): Promise<
    | { applied: true; commitId: string; previousHead: string | null; changedPaths: string[] }
    | { applied: false; requiresRebuild: true }
> {
    const plan = await planWikiRollback(context, remainingMessages)
    if (!plan.commitId || plan.requiresRebuild) {
        return { applied: false, requiresRebuild: true }
    }
    const result = await checkoutWikiVersion({
        ...clientInput(context),
        commitId: plan.commitId,
        reason,
    })
    if (result.changedPaths.length > 0) {
        announceRisuBardMemoryUpdated({
            characterId: context.characterId,
            chatId: context.chatId,
        })
    }
    return {
        applied: true,
        commitId: result.commitId,
        previousHead: result.previousHead,
        changedPaths: result.changedPaths,
    }
}

/**
 * Creates the destination chat's wiki from the commit that matches the fork
 * point. Returns null when the point is unrecorded, so the caller can fall back
 * to a rebuilt branch instead of attaching unrelated future state.
 */
export async function createWikiBranchAt(
    input: {
        characterId: string
        sourceChatId: string
        destinationChatId: string
        forkMessages: readonly Message[]
        fetchImpl: typeof fetch
        createAuth(): Promise<string>
    }
): Promise<{ commitId: string } | null> {
    const source = {
        characterId: input.characterId,
        chatId: input.sourceChatId,
        fetchImpl: input.fetchImpl,
        createAuth: input.createAuth,
    }
    await ensureWikiVersion(clientInput(source))
    const anchors = anchorMessagesFromChat(input.forkMessages)
    if (anchors.length === 0) return null
    const commitId = await findWikiCommitForPrefix({
        ...clientInput(source),
        messages: anchors,
        minimumBoundaryMessageId: latestConfirmedBoundary(input.forkMessages),
    })
    if (!commitId) return null
    const forked = await forkWikiVersion({
        characterId: input.characterId,
        sourceChatId: input.sourceChatId,
        destinationChatId: input.destinationChatId,
        commitId,
        fetchImpl: input.fetchImpl,
        createAuth: input.createAuth,
    })
    return { commitId: forked.commitId }
}

/** True when every message has an identity the version store can anchor to. */
export function chatSupportsWikiAnchoring(chat: Chat | undefined): boolean {
    if (!chat || !Array.isArray(chat.message)) return false
    return chat.message.some((message) =>
        typeof message?.chatId === 'string' && message.chatId.length > 0
    )
}

/**
 * Records the current working tree as a `legacy-baseline` commit the first time
 * a chat is versioned. The Markdown files are not modified, so an existing user
 * keeps their wiki exactly as it is and gains history from this point on.
 */
export async function ensureWikiBaselineForChat(
    context: WikiChatContext,
    messages: readonly Message[]
): Promise<{ created: boolean; commitId: string | null }> {
    const anchors = anchorMessagesFromChat(messages)
    const result = await ensureWikiVersion({
        ...clientInput(context),
        ...(anchors.length > 0
            ? { chatAnchor: chatBoundaryAnchor(
                context.chatId, anchors.at(-1)?.messageId ?? null, anchors
            ) }
            : {}),
    })
    return { created: result.created, commitId: result.commitId }
}

export async function preserveWikiChat(
    context: WikiChatContext,
    chat: Chat,
    reason: WikiRecoveryReason
): Promise<string> {
    await requestImmediateSave({ forceFullWrite: true, rejectOnFailure: true })
    await ensureWikiBaselineForChat(context, chat.message)
    await captureWikiVersion(context)
    const head = (await listWikiHistory(context))[0]?.commitId
    if (!head) throw new Error('Wiki recovery head is missing')
    await createWikiRecovery({
        ...context,
        commitId: head,
        reason,
        chatBase64: Buffer.from(encodeMemorySaveChat(chat)).toString('base64'),
    })
    return head
}
