import type { CanonicalTurnReceipt } from './memoryWiki'
import { normalizeWikiWritingLanguage, type WikiWritingLanguage } from './wikiWritingLanguage'

export type WikiRebootBatchSize = 1 | 2
export type WikiRebootStatus =
    | 'running'
    | 'stop-requested'
    | 'paused'
    | 'failed'
    | 'finalizing'

export interface WikiRebootJob {
    version: 1
    jobId: string
    stagingChatId: string
    batchSize: WikiRebootBatchSize
    writingLanguage?: WikiWritingLanguage
    status: WikiRebootStatus
    targetAssistantMessageIds: string[]
    completedAssistantMessageIds: string[]
    receipts: Record<string, CanonicalTurnReceipt>
    startedAt: number
    updatedAt: number
    inFlightAssistantMessageIds?: string[]
    replacementForkToken?: string
    lastError?: string
}

export interface WikiRebootMessage {
    messageId: string
    role: 'user' | 'assistant'
    content: string
}

export interface WikiRebootTurn {
    assistantMessageId: string
    messageIds: string[]
    messages: WikiRebootMessage[]
}

interface StoredMessageLike {
    role?: unknown
    data?: unknown
    chatId?: unknown
    disabled?: unknown
    isComment?: unknown
}

const statuses = new Set<WikiRebootStatus>([
    'running', 'stop-requested', 'paused', 'failed', 'finalizing',
])

function stableId(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
        && value.length <= 1_024
}

function active(message: StoredMessageLike): boolean {
    return !message.disabled && !message.isComment
}

export function projectWikiRebootTurns(
    storedMessages: readonly StoredMessageLike[],
    startChatIndex = 0,
    includeUserMessages = true,
): WikiRebootTurn[] {
    const turns: WikiRebootTurn[] = []
    let latestUser: StoredMessageLike | undefined
    for (const [index, message] of storedMessages.entries()) {
        if (!active(message) || typeof message.data !== 'string'
            || !stableId(message.chatId)) continue
        if (message.role === 'user') {
            latestUser = message
            continue
        }
        if (message.role !== 'char' || index < startChatIndex) continue
        const messages: WikiRebootMessage[] = []
        if (includeUserMessages && latestUser && stableId(latestUser.chatId)
            && typeof latestUser.data === 'string') {
            messages.push({
                messageId: latestUser.chatId,
                role: 'user',
                content: latestUser.data,
            })
        }
        messages.push({
            messageId: message.chatId,
            role: 'assistant',
            content: message.data,
        })
        turns.push({
            assistantMessageId: message.chatId,
            messageIds: messages.map((item) => item.messageId),
            messages,
        })
    }
    return turns
}

export function createWikiRebootJob(input: {
    jobId: string
    stagingChatId: string
    batchSize: WikiRebootBatchSize
    targetAssistantMessageIds: string[]
    now?: number
    writingLanguage?: WikiWritingLanguage
}): WikiRebootJob {
    const now = input.now ?? Date.now()
    return {
        version: 1,
        jobId: input.jobId,
        stagingChatId: input.stagingChatId,
        batchSize: input.batchSize,
        writingLanguage: normalizeWikiWritingLanguage(input.writingLanguage),
        status: 'running',
        targetAssistantMessageIds: [...input.targetAssistantMessageIds],
        completedAssistantMessageIds: [],
        receipts: {},
        startedAt: now,
        updatedAt: now,
    }
}

export function nextWikiRebootBatch(
    job: WikiRebootJob,
    turns: readonly WikiRebootTurn[]
): WikiRebootTurn[] {
    const targets = new Set(job.targetAssistantMessageIds)
    const completed = new Set(job.completedAssistantMessageIds)
    return turns.filter((turn) =>
        targets.has(turn.assistantMessageId)
        && !completed.has(turn.assistantMessageId)
    ).slice(0, job.batchSize)
}

export function blocksChatGeneration(job?: WikiRebootJob): boolean {
    return Boolean(job)
}

export function resolveWikiRebootViewChatId(
    chatId: string,
    job?: WikiRebootJob
): string {
    return job?.stagingChatId ?? chatId
}

export function normalizeWikiRebootJob(value: unknown): WikiRebootJob | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const job = value as Partial<WikiRebootJob>
    if (job.version !== 1 || !stableId(job.jobId)
        || !stableId(job.stagingChatId)
        || (job.batchSize !== 1 && job.batchSize !== 2)
        || !statuses.has(job.status as WikiRebootStatus)
        || !Array.isArray(job.targetAssistantMessageIds)
        || !job.targetAssistantMessageIds.every(stableId)
        || !Array.isArray(job.completedAssistantMessageIds)
        || !job.completedAssistantMessageIds.every(stableId)
        || !job.receipts || typeof job.receipts !== 'object'
        || !Number.isFinite(job.startedAt) || !Number.isFinite(job.updatedAt)) {
        return undefined
    }
    const interrupted = job.status === 'running'
        || job.status === 'stop-requested'
        || job.status === 'finalizing'
    return {
        ...(job as WikiRebootJob),
        writingLanguage: normalizeWikiWritingLanguage(job.writingLanguage),
        status: interrupted ? 'paused' : job.status as WikiRebootStatus,
        targetAssistantMessageIds: [...new Set(job.targetAssistantMessageIds)],
        completedAssistantMessageIds: [...new Set(
            job.completedAssistantMessageIds
        )],
        receipts: { ...job.receipts },
        ...(Array.isArray(job.inFlightAssistantMessageIds)
            && job.inFlightAssistantMessageIds.every(stableId)
            ? { inFlightAssistantMessageIds: [
                ...job.inFlightAssistantMessageIds,
            ] }
            : {}),
        ...(stableId(job.replacementForkToken)
            ? { replacementForkToken: job.replacementForkToken }
            : {}),
    }
}
