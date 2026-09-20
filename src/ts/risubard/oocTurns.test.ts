import { describe, expect, test } from 'vitest'
import { oocTurnIndices, preserveOocTurnMarker } from './oocTurns'
import { projectConfirmedMemoryTurn, projectRecentMemoryMessages } from './memoryAnalysisClient'
import { createWikiRebootJob, normalizeWikiRebootJob, projectWikiRebootTurns } from './wikiReboot'
import { resolveRisuBardChatSettings } from './risuBardSettings'
import { findHistoricalSourceMatches, resolveHistoricalSourceMatchesById } from './historicalSourceRecall'

const transcript = [
    { role: 'user', chatId: 'u1', data: 'Open the door' },
    { role: 'char', chatId: 'a1', data: 'The door opens' },
    { role: 'user', chatId: 'u2', data: 'Discuss the next chapter' },
    { role: 'char', chatId: 'a2', data: '<!-- OOC_turn --> Let us plan a betrayal' },
    { role: 'user', chatId: 'u3', data: 'Enter the room' },
    { role: 'char', chatId: 'a3', data: 'The room is empty' },
]

describe('OOC wiki exclusion', () => {
    test('reboot snapshots survive resume, and legacy jobs retain their original batch', () => {
        const create = (ignoreOocTurns: boolean) => createWikiRebootJob({
            jobId: 'job', stagingChatId: 'staging', batchSize: 1,
            targetAssistantMessageIds: ['a1', 'a2', 'a3'], ignoreOocTurns,
        })
        for (const ignore of [true, false]) {
            const resumed = normalizeWikiRebootJob(JSON.parse(JSON.stringify(create(ignore))))!
            expect(resumed.ignoreOocTurns).toBe(ignore)
            expect(projectWikiRebootTurns(transcript, 0, true, resumed.ignoreOocTurns === true)).toHaveLength(ignore ? 2 : 3)
        }
        const legacy = create(false)
        delete legacy.ignoreOocTurns
        legacy.inFlightAssistantMessageIds = ['a2']
        const resumed = normalizeWikiRebootJob(legacy)!
        expect(projectWikiRebootTurns(transcript, 0, true, resumed.ignoreOocTurns === true).some(turn => turn.assistantMessageId === 'a2')).toBe(true)
    })
    test('excludes OOC from historical recall and explicit source reads while retaining original indices', () => {
        const source = { messages: transcript, excludeRecentMessages: 1 }
        expect(findHistoricalSourceMatches({ ...source, currentInput: 'betrayal' })).toEqual([])
        expect(resolveHistoricalSourceMatchesById({ ...source, messageIds: ['u2', 'a2'] })).toEqual([])
        expect(resolveHistoricalSourceMatchesById({ ...source, messageIds: ['a2'], ignoreOocTurns: false })[0]?.occurredAt).toBe(3)
        expect(resolveHistoricalSourceMatchesById({ ...source, messageIds: ['a1'] })[0]?.occurredAt).toBe(1)
    })
    test('preserves an existing marker when an output regex removes the OOC heading', () => {
        const original = '<!-- OOC_turn -->\n## OOC Response\nLet us plan'
        const processed = original.replace(/([\s\S]*)#{1,4}\s{0,1}(OOC Response)\n+([\s\S]*)/, '$3')
        expect(preserveOocTurnMarker(original, processed)).toBe('<!-- OOC_turn -->\nLet us plan')
        expect(preserveOocTurnMarker('Story text', 'Edited story')).toBe('Edited story')
        expect(preserveOocTurnMarker(original, original)).toBe(original)
    })
    test('excludes the pair without mutating saved data or renumbering reboot starts', () => {
        const original = structuredClone(transcript)
        expect([...oocTurnIndices(transcript)]).toEqual([3, 2])
        expect(projectWikiRebootTurns(transcript, 4).map(t => t.messageIds)).toEqual([['u3', 'a3']])
        expect(projectRecentMemoryMessages(transcript).map(m => m.messageId)).toEqual(['u1', 'a1', 'u3', 'a3'])
        expect(transcript).toEqual(original)
    })
    test('skips automatic, manual, and explicit reanalysis targets', () => {
        expect(projectConfirmedMemoryTurn(transcript.slice(0, 5))).toBeNull()
        expect(projectConfirmedMemoryTurn(transcript, 'a2')).toBeNull()
        expect(projectConfirmedMemoryTurn(transcript, 'a2', { includeConfirmed: true })).toBeNull()
        expect(projectConfirmedMemoryTurn(transcript, 'a3')?.messages.map(m => m.messageId)).toEqual(['u3', 'a3'])
    })
    test('opt-out restores marked turns in every projection', () => {
        expect(projectRecentMemoryMessages(transcript, 12, undefined, undefined, true, false)).toHaveLength(6)
        expect(projectWikiRebootTurns(transcript, 0, true, false)).toHaveLength(3)
        expect(projectConfirmedMemoryTurn(transcript, 'a2', { ignoreOocTurns: false })?.messages).toHaveLength(2)
    })
    test('does not reattach an excluded user to an assistant continuation', () => {
        const messages = [...transcript.slice(0, 4), { role: 'char', chatId: 'a4', data: 'Story continuation' }]
        expect(projectConfirmedMemoryTurn(messages, 'a4')?.messages.map(m => m.messageId)).toEqual(['a4'])
        expect(projectWikiRebootTurns(messages).at(-1)?.messageIds).toEqual(['a4'])
    })
    test('ignores disabled markers and detects the exact marker anywhere', () => {
        expect(oocTurnIndices([{ role: 'char', data: '<!-- OOC_turn -->', disabled: true }]).size).toBe(0)
        expect(oocTurnIndices([{ role: 'char', data: 'prefix <!-- OOC_turn --> suffix' }]).has(0)).toBe(true)
        expect(oocTurnIndices([{ role: 'user', data: '<!-- OOC_turn -->' }]).size).toBe(0)
    })
    test('defaults on and respects global and chat opt-out', () => {
        expect(resolveRisuBardChatSettings({}).risuBardIgnoreOocTurns).toBe(true)
        expect(resolveRisuBardChatSettings({ risuBardIgnoreOocTurns: false }).risuBardIgnoreOocTurns).toBe(false)
        expect(resolveRisuBardChatSettings({ risuBardIgnoreOocTurns: true }, { risuBardIgnoreOocTurns: false }).risuBardIgnoreOocTurns).toBe(false)
    })
})
