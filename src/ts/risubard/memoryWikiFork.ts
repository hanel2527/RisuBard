import { invokeBrowserFetch } from './browserFetch'
import { announceRisuBardMemoryUpdated } from './memoryEvents'

export type MemoryWikiForkMode = 'copy' | 'branch'

export interface MemoryWikiForkReceipt {
    mode: MemoryWikiForkMode
    sourceExists: boolean
    destinationChatId: string
    warnings: string[]
    forkToken: string
}

export type MemoryWikiForkCompletionAction = 'finalize' | 'discard'

export interface MemoryWikiForkCompletionReceipt {
    action: MemoryWikiForkCompletionAction
    completed: true
}

interface BaseForkInput {
    characterId: string
    destinationCharacterId?: string
    sourceChatId: string
    destinationChatId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}

type MemoryWikiForkInput = BaseForkInput & (
    | { mode: 'copy'; retainedMessageIds?: never }
    | {
        mode: 'branch'
        retainedMessageIds: string[]
        messageIds: string[]
    }
)

function boundedId(value: string, label: string): string {
    if (typeof value !== 'string'
        || value.trim().length === 0
        || value.length > 1_024) {
        throw new Error(`${label} must be a non-empty bounded ID`)
    }
    return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function forkMemoryWiki(
    input: MemoryWikiForkInput
): Promise<MemoryWikiForkReceipt> {
    const base = {
        characterId: boundedId(input.characterId, 'Character ID'),
        ...(input.destinationCharacterId ? {
            destinationCharacterId: boundedId(
                input.destinationCharacterId,
                'Destination character ID'
            ),
        } : {}),
        sourceChatId: boundedId(input.sourceChatId, 'Source chat ID'),
        destinationChatId: boundedId(
            input.destinationChatId,
            'Destination chat ID'
        ),
        mode: input.mode,
    }
    if (base.sourceChatId === base.destinationChatId) {
        throw new Error('Memory fork source and destination must differ')
    }
    let body: typeof base | (typeof base & {
        retainedMessageIds: string[]
        messageIds: string[]
    })
    if (input.mode === 'branch') {
        const retainedMessageIds = input.retainedMessageIds.map((id) =>
            boundedId(id, 'Retained message ID')
        )
        const messageIds = input.messageIds.map((id) =>
            boundedId(id, 'Message ID')
        )
        if (new Set(messageIds).size !== messageIds.length
            || new Set(retainedMessageIds).size !== retainedMessageIds.length
            || retainedMessageIds.length > messageIds.length
            || retainedMessageIds.some((id, index) =>
                messageIds[index] !== id
            )) {
            throw new Error('Branch message IDs must be an ordered prefix')
        }
        body = { ...base, retainedMessageIds, messageIds }
    }
    else {
        body = base
    }
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/fork',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify(body),
        }
    )
    if (!response.ok) {
        const failure: unknown = await response.json().catch(() => undefined)
        const detail = isRecord(failure)
            && typeof failure.error === 'string'
            && failure.error.length <= 1_000
            ? `: ${failure.error}`
            : ''
        throw new Error(
            `Memory fork failed with status ${response.status}${detail}`
        )
    }
    const value: unknown = await response.json()
    if (!isRecord(value)
        || Object.keys(value).length !== 5
        || value.mode !== input.mode
        || typeof value.sourceExists !== 'boolean'
        || value.destinationChatId !== input.destinationChatId
        || !Array.isArray(value.warnings)
        || !value.warnings.every((warning) => typeof warning === 'string')
        || typeof value.forkToken !== 'string'
        || value.forkToken.trim().length === 0
        || value.forkToken.length > 1_024) {
        throw new Error('Invalid memory fork receipt')
    }
    return {
        mode: input.mode,
        sourceExists: value.sourceExists,
        destinationChatId: input.destinationChatId,
        warnings: value.warnings,
        forkToken: value.forkToken,
    }
}

export async function completeMemoryWikiFork(input: {
    characterId: string
    destinationChatId: string
    forkToken: string
    action: MemoryWikiForkCompletionAction
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<MemoryWikiForkCompletionReceipt> {
    const body = {
        characterId: boundedId(input.characterId, 'Character ID'),
        destinationChatId: boundedId(
            input.destinationChatId,
            'Destination chat ID'
        ),
        forkToken: boundedId(input.forkToken, 'Fork token'),
        action: input.action,
    }
    if (body.action !== 'finalize' && body.action !== 'discard') {
        throw new Error('Invalid memory fork completion action')
    }
    const completeOnce = async (): Promise<MemoryWikiForkCompletionReceipt> => {
        const response = await invokeBrowserFetch(
            input.fetchImpl,
            '/api/risubard/memory/fork/complete',
            {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'content-type': 'application/json',
                    'risu-auth': await input.createAuth(),
                },
                body: JSON.stringify(body),
            }
        )
        if (!response.ok) {
            const failure: unknown = await response.json()
                .catch(() => undefined)
            const detail = isRecord(failure)
                && typeof failure.error === 'string'
                && failure.error.length <= 1_000
                ? `: ${failure.error}`
                : ''
            throw new Error(
                `Memory fork completion failed with status ${response.status}${detail}`
            )
        }
        const value: unknown = await response.json()
        if (!isRecord(value)
            || Object.keys(value).length !== 2
            || value.action !== input.action
            || value.completed !== true) {
            throw new Error('Invalid memory fork completion receipt')
        }
        return { action: input.action, completed: true }
    }
    let receipt: MemoryWikiForkCompletionReceipt
    try {
        receipt = await completeOnce()
    }
    catch (error) {
        if (input.action !== 'finalize') throw error
        receipt = await completeOnce()
    }
    if (receipt.action === 'finalize') {
        announceRisuBardMemoryUpdated({
            characterId: input.characterId,
            chatId: input.destinationChatId,
        })
    }
    return receipt
}
