import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../storage/database.svelte'
import type { StoryChatDelta, StoryHistoryState, StoryPendingWiki } from './storyHistoryTypes'

vi.mock('../globalApi.svelte', () => ({ forageStorage: {
    Init: async () => {},
    realStorage: {
        requestStoryHistory: (action: string, body: Record<string, unknown>) => fetch(`/api/risubard/memory/history/${action}`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': 'existing-writer' },
            body: JSON.stringify(body),
        }),
    },
} }))
vi.mock('../platform', () => ({ isNodeServer: true }))
vi.mock('../bardPainter/chatScope', () => ({ rebindPainterChatScope: vi.fn() }))
const memoryUpdated = vi.hoisted(() => vi.fn())
vi.mock('./memoryEvents', () => ({
    RISUBARD_MEMORY_UPDATED_EVENT: 'risubard-memory-updated',
    announceRisuBardMemoryUpdated: memoryUpdated,
}))
import { beginStoryWiki, captureStoryChat, finishStoryWiki, getStoryHistory, keepStoryWiki, loadStoryBackup, migrateStoryHistory, registerStoryWikiRetry, requireStoryWikiReady, retryStoryWiki } from './storyHistory'

function initialState(): StoryHistoryState {
    return { mode: 'history', revision: 1, epoch: 0, headId: null, branchId: null,
        wikiCommitId: 'wiki', workingSnapshotId: null, quickSaveId: null, anchorMessageId: null,
        bindings: { first: 'wiki' }, pendingWiki: null, pendingCheckout: null, branches: [], backups: [] }
}
function pending(status: StoryPendingWiki['status']): StoryPendingWiki {
    return { operationId: 'operation', sourceBackupId: 'candidate', sourceChatSnapshotId: 'target-snapshot',
        targetMessageId: 'second', sourceMessageIds: ['first', 'second'], recoveryManifestHash: 'recovery',
        parentCommitId: 'wiki', epoch: 0, status, ...(status === 'failed' ? { error: 'partial write' } : {}) }
}
let state: StoryHistoryState
let calls: Array<{ action: string; body: { delta: StoryChatDelta; operationId: string; outcome: string; destinationChatId: string; chat?: Chat } }>
let restored: Chat
beforeEach(() => {
    state = initialState()
    calls = []
    memoryUpdated.mockClear()
    restored = { id: 'restored', name: 'Past', note: '', localLore: [], scriptstate: { turn: 1 },
        message: [{ chatId: 'first', role: 'char', data: 'past' }] }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get('x-session-id')).toBe('existing-writer')
        const action = url.split('/').at(-1)!
        const body = JSON.parse(init.body as string)
        calls.push({ action, body })
        if (action === 'migrate') {
            state = initialState()
            return Response.json({ state, report: {} })
        }
        if (action === 'capture') state = { ...state, revision: state.revision + 1,
            headId: `backup-${state.revision}`, workingSnapshotId: `snapshot-${state.revision}` }
        if (action === 'begin-wiki') state = { ...state, pendingWiki: pending('writing') }
        if (action === 'finish-wiki') state = { ...state, pendingWiki: body.outcome === 'failed' ? pending('failed') : null }
        if (action === 'complete-checkout') return Response.json({ error: 'Acknowledgment unavailable' }, { status: 503 })
        if (action === 'checkout') return Response.json({ chat: restored, forkToken: 'token', state,
            destinationChatId: body.destinationChatId })
        return Response.json(state)
    }))
})
const chat = (id: string): Chat => ({ id, name: 'Story', note: '', localLore: [], scriptstate: { turn: 2 },
    message: [{ chatId: 'first', role: 'char', data: 'one', risubardMemoryConfirmed: true },
        { chatId: 'second', role: 'char', data: 'two' }] })

describe('incremental story history client', () => {
    it('transfers only an edited message without rewriting following data, state or binds', async () => {
        const current = chat('incremental')
        await captureStoryChat('owner', current)
        current.message[0].data = 'edited'
        await captureStoryChat('owner', current, 'chat-edit')
        await captureStoryChat('owner', current, 'chat-edit')
        const captures = calls.filter(call => call.action === 'capture')
        expect(captures).toHaveLength(2)
        expect(captures[0].body.delta.messages).toHaveLength(2)
        expect(captures[1].body.delta.messages).toEqual([{ id: 'first', value: current.message[0] }])
        expect(captures[1].body.delta.order).toEqual(['first', 'second'])
        expect(captures[1].body.delta.state.scriptstate).toEqual({ turn: 2 })
        expect(current.message[1].data).toBe('two')
        expect(current.message[0].risubardMemoryConfirmed).toBe(true)
        expect(state.bindings).toEqual({ first: 'wiki' })
    })
    it('freezes response variables before waiting for another queued capture', async () => {
        const current = chat('frozen')
        const first = captureStoryChat('owner', current)
        current.scriptstate = { turn: 3 }
        current.message[1].data = 'next revision'
        const second = captureStoryChat('owner', current)
        await Promise.all([first, second])
        const captures = calls.filter(call => call.action === 'capture')
        expect(captures[0].body.delta.state.scriptstate).toEqual({ turn: 2 })
        expect(captures[0].body.delta.messages[1].value.data).toBe('two')
        expect(captures[1].body.delta.state.scriptstate).toEqual({ turn: 3 })
        expect(captures[1].body.delta.messages).toHaveLength(1)
    })
    it('makes capture an explicit no-op for unmigrated legacy chats', async () => {
        state.mode = 'legacy'
        expect((await captureStoryChat('owner', chat('legacy'))).mode).toBe('legacy')
        expect(calls.some(call => call.action === 'capture')).toBe(false)
    })
    it('starts an opted-in chat once without re-enabling VCS after a legacy rollback', async () => {
        state.mode = 'legacy'
        const current = chat('new-history')
        current.risuBardInitializeHistory = true
        expect((await getStoryHistory('owner', current.id!, current)).mode).toBe('history')
        expect(current.risuBardInitializeHistory).toBeUndefined()
        const initial = calls.find(call => call.action === 'migrate')!.body.chat!
        expect(initial.risuBardInitializeHistory).toBeUndefined()
        expect(initial.message).toEqual(current.message)
        expect(initial.scriptstate).toEqual({ turn: 2 })
        state.mode = 'legacy'
        expect((await captureStoryChat('owner', current)).mode).toBe('legacy')
        expect(calls.filter(call => call.action === 'migrate')).toHaveLength(1)
    })
    it('keeps new-chat initialization pending after a failure and resumes it on the next capture', async () => {
        state.mode = 'legacy'
        const current = chat('failed-initialization')
        current.risuBardInitializeHistory = true
        const originalFetch = fetch
        let fail = true
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            if (url.endsWith('/migrate') && fail) {
                fail = false
                return Response.json({ error: 'Disk unavailable' }, { status: 503 })
            }
            return originalFetch(url, init)
        })
        await expect(captureStoryChat('owner', current)).rejects.toThrow('Disk unavailable')
        expect(current.risuBardInitializeHistory).toBe(true)
        expect((await captureStoryChat('owner', current)).mode).toBe('history')
        expect(current.risuBardInitializeHistory).toBeUndefined()
    })
    it('installs a committed checkout without an acknowledgment and preserves prompt settings and baseline', async () => {
        const current = chat('checkout')
        current.bindedPersona = 'current-persona'
        const loaded = await loadStoryBackup('owner', current, 'past')
        expect(loaded.id).toBe('checkout')
        expect(loaded.bindedPersona).toBe('current-persona')
        expect(calls.some(call => call.action === 'complete-checkout')).toBe(false)
        expect(memoryUpdated).toHaveBeenCalledWith({ characterId: 'owner', chatId: 'checkout' })
        const count = calls.filter(call => call.action === 'capture').length
        await captureStoryChat('owner', loaded, 'chat-edit')
        expect(calls.filter(call => call.action === 'capture')).toHaveLength(count)
    })
})

describe('durable pending wiki gate', () => {
    it.each(['writing', 'failed', 'cancelled'] as const)('blocks generation for restarted %s operations and allows explicit kept', async status => {
        state.pendingWiki = pending(status)
        await expect(requireStoryWikiReady('owner', `restart-${status}`)).rejects.toThrow('기존 위키로 확정')
        expect(await keepStoryWiki('owner', `restart-${status}`)).toBe(true)
        expect(calls.find(call => call.action === 'finish-wiki')?.body).toMatchObject({ operationId: 'operation', outcome: 'kept' })
    })
    it('does not race retry/kept with an operation that is still active in this page', async () => {
        await beginStoryWiki({ characterId: 'owner', chatId: 'active', operationId: 'operation',
            targetMessageId: 'second', sourceMessageIds: ['first', 'second'], sourceBackupId: 'candidate' })
        await expect(keepStoryWiki('owner', 'active')).rejects.toThrow('진행 중')
        await finishStoryWiki({ characterId: 'owner', chatId: 'active', operationId: 'operation', outcome: 'failed' })
        const retry = vi.fn(async () => true)
        registerStoryWikiRetry(retry)
        expect(await retryStoryWiki('owner', 'active')).toBe(true)
        expect(retry).toHaveBeenCalledWith('owner', 'active', expect.objectContaining({ operationId: 'operation', sourceBackupId: 'candidate' }))
    })
})

it('resumes a failed transition with its operation ID, but never reuses a successful operation', async () => {
    const operations: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const body: { operationId: string; dryRun?: boolean } = JSON.parse(init.body as string)
        operations.push(body.operationId)
        if (operations.length === 1) return Response.json({ error: 'connection failed' }, { status: 503 })
        return Response.json({ state, report: { operationId: body.operationId, legacySlots: 0, backups: 0, estimatedBytes: 0 } })
    }))
    const current = chat('transition-retry')
    await expect(migrateStoryHistory('owner', current)).rejects.toThrow('connection failed')
    await migrateStoryHistory('owner', current, { dryRun: true })
    await migrateStoryHistory('owner', current)
    await migrateStoryHistory('owner', current)
    expect(operations[0]).toBe(operations[2])
    expect(operations[1]).not.toBe(operations[0])
    expect(operations[3]).not.toBe(operations[0])
})
