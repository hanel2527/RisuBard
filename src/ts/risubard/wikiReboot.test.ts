import { describe, expect, test } from 'vitest'
import {
    blocksChatGeneration,
    createWikiRebootJob,
    nextWikiRebootBatch,
    normalizeWikiRebootJob,
    projectWikiRebootTurns,
    resolveWikiRebootViewChatId,
} from './wikiReboot'

const messages = [
    { role: 'user', data: 'u1', chatId: 'u1' },
    { role: 'char', data: 'a1', chatId: 'a1' },
    { role: 'user', data: 'ignored', chatId: 'ux', disabled: true },
    { role: 'char', data: 'ignored', chatId: 'ax', isComment: true },
    { role: 'user', data: 'u2', chatId: 'u2' },
    { role: 'char', data: 'a2', chatId: 'a2' },
    { role: 'char', data: 'a3', chatId: 'a3' },
] as const

describe('BardWiki reboot domain', () => {
    test('excludes user evidence and source IDs together when analysis omits user messages', () => {
        const turns = projectWikiRebootTurns(messages, 0, false)
        expect(turns.map(turn => turn.assistantMessageId)).toEqual(['a1', 'a2', 'a3'])
        for (const turn of turns) {
            expect(turn.messageIds).toEqual([turn.assistantMessageId])
            expect(turn.messages).toEqual([{
                messageId: turn.assistantMessageId,
                role: 'assistant',
                content: turn.assistantMessageId,
            }])
        }
        const job = createWikiRebootJob({
            jobId: 'import-reboot', stagingChatId: 'staging', batchSize: 2,
            targetAssistantMessageIds: turns.map(turn => turn.assistantMessageId),
        })
        expect(nextWikiRebootBatch(job, turns).flatMap(turn => turn.messageIds))
            .toEqual(['a1', 'a2'])
        expect(projectWikiRebootTurns(messages, 5, false).map(turn => turn.messageIds))
            .toEqual([['a2'], ['a3']])
    })

    test('persists the starting language across resume and keeps legacy jobs Korean', () => {
        const job = createWikiRebootJob({ jobId: 'job-en', stagingChatId: 'reboot-en',
            batchSize: 2, targetAssistantMessageIds: ['a1'], writingLanguage: 'en' })
        expect(job.writingLanguage).toBe('en')
        expect(normalizeWikiRebootJob(JSON.parse(JSON.stringify(job)))?.writingLanguage).toBe('en')
        expect(normalizeWikiRebootJob({ ...job, writingLanguage: undefined })?.writingLanguage).toBe('ko')
    })

    test('projects active stable assistant turns with their preceding user', () => {
        expect(projectWikiRebootTurns(messages)).toEqual([
            { assistantMessageId: 'a1', messageIds: ['u1', 'a1'], messages: [
                { messageId: 'u1', role: 'user', content: 'u1' },
                { messageId: 'a1', role: 'assistant', content: 'a1' },
            ] },
            { assistantMessageId: 'a2', messageIds: ['u2', 'a2'], messages: [
                { messageId: 'u2', role: 'user', content: 'u2' },
                { messageId: 'a2', role: 'assistant', content: 'a2' },
            ] },
            { assistantMessageId: 'a3', messageIds: ['u2', 'a3'], messages: [
                { messageId: 'u2', role: 'user', content: 'u2' },
                { messageId: 'a3', role: 'assistant', content: 'a3' },
            ] },
        ])
    })

    test('starts projection at a chat index and keeps the paired user message', () => {
        expect(projectWikiRebootTurns(messages, 5)).toEqual([
            { assistantMessageId: 'a2', messageIds: ['u2', 'a2'], messages: [
                { messageId: 'u2', role: 'user', content: 'u2' },
                { messageId: 'a2', role: 'assistant', content: 'a2' },
            ] },
            { assistantMessageId: 'a3', messageIds: ['u2', 'a3'], messages: [
                { messageId: 'u2', role: 'user', content: 'u2' },
                { messageId: 'a3', role: 'assistant', content: 'a3' },
            ] },
        ])
        expect(projectWikiRebootTurns(messages, 6).map((turn) =>
            turn.assistantMessageId
        )).toEqual(['a3'])
    })

    test('selects one or two remaining turns and keeps an odd final turn', () => {
        const turns = projectWikiRebootTurns(messages)
        const two = createWikiRebootJob({
            jobId: 'job', stagingChatId: 'reboot-job', batchSize: 2,
            targetAssistantMessageIds: turns.map((turn) => turn.assistantMessageId),
            now: 10,
        })
        expect(nextWikiRebootBatch(two, turns).map((turn) =>
            turn.assistantMessageId
        )).toEqual(['a1', 'a2'])
        two.completedAssistantMessageIds = ['a1', 'a2']
        expect(nextWikiRebootBatch(two, turns).map((turn) =>
            turn.assistantMessageId
        )).toEqual(['a3'])
        two.batchSize = 1
        two.completedAssistantMessageIds = []
        expect(nextWikiRebootBatch(two, turns)).toHaveLength(1)
    })

    test('normalizes persisted jobs and blocks generation until cleared', () => {
        const job = normalizeWikiRebootJob({
            version: 1, jobId: 'job', stagingChatId: 'reboot-job', batchSize: 2,
            status: 'running', targetAssistantMessageIds: ['a1'],
            completedAssistantMessageIds: [], receipts: {},
            startedAt: 1, updatedAt: 2,
        })
        expect(job?.status).toBe('paused')
        expect(blocksChatGeneration(job)).toBe(true)
        expect(normalizeWikiRebootJob({ ...job, batchSize: 3 })).toBeUndefined()
        expect(blocksChatGeneration(undefined)).toBe(false)
    })

    test('shows the staging wiki while a reboot job exists', () => {
        const job = createWikiRebootJob({
            jobId: 'job', stagingChatId: 'reboot-job', batchSize: 2,
            targetAssistantMessageIds: ['a1'], now: 10,
        })

        expect(resolveWikiRebootViewChatId('chat', job)).toBe('reboot-job')
        expect(resolveWikiRebootViewChatId('chat', undefined)).toBe('chat')
    })
})
