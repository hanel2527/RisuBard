import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, test, vi } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/ts/globalApi.svelte.ts'), 'utf8')
const start = source.indexOf('    async function triggerSave(')
const end = source.indexOf('    let savetrys = 0', start)
const controller = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })
const tracking = ts.transpile(source.slice(source.indexOf('    function hasTrackedChanges('), source.indexOf('    async function flushServerDbNow(')), { target: ts.ScriptTarget.ES2022 })
const requeue = ts.transpile(source.slice(source.indexOf('    function requeueTrackedChanges('), source.indexOf('    function collectChatsToPersist(')), { target: ts.ScriptTarget.ES2022 })

function fixture(dirty = true) {
    const sync = vi.fn(async () => {})
    const save = vi.fn(async (_changes: any) => 'saved')
    const flush = vi.fn(async () => {})
    const create = new Function('syncLiveFilesNow', 'persistTrackedChanges', 'flushServerDbNow', 'initialDirty', `
        let saveInFlight = null, requestImmediateSaveImpl, savetrys = 0, changed = false, forceFullWriteOnRetry = false, gotChannel = false, untrackedSweepPending = false, lastImmediateSaveAt = 0;
        const supportsPatchSync = true, saving = {}, lastLiveError = '';
        const saveRuntime = { isActive: () => true }, language = { sessionSavePausedTitle: 'paused' };
        const changeTracker = { root: initialDirty, character: [], chat: [], botPreset: false, modules: false, plugins: false, pluginCustomStorage: false };
        const safeStructuredClone = structuredClone;
        ${tracking}
        ${requeue}
        const tick = async () => {}, refreshThisRuntime = syncLiveFilesNow;
        const sleep = async () => {}, alertError = () => {}, sessionHandoff = { show() {} };
        ${controller}
        return { request: requestImmediateSaveImpl, changeTracker };
    `)
    return { sync, save, flush, ...create(sync, save, flush, dirty) }
}

test('a preset-only save does not retransmit the chat or character already saved', async () => {
    const f = fixture()
    f.changeTracker.character.push('bot')
    f.changeTracker.chat.push(['bot', 'chat'])
    await f.request({ flushServer: 'canonical', rejectOnFailure: true })
    f.changeTracker.root = true
    await f.request({ flushServer: 'canonical', rejectOnFailure: true })
    expect(f.save.mock.calls[0][0]).toMatchObject({ chat: [['bot', 'chat']], character: ['bot'] })
    expect(f.save.mock.calls[1][0]).toMatchObject({ root: true, chat: [], character: [] })
})

test('edits made during a save remain dirty and a failed save requeues its batch', async () => {
    const f = fixture()
    f.changeTracker.chat.push(['bot', 'first'])
    f.save.mockImplementationOnce(async () => {
        f.changeTracker.chat.push(['bot', 'second'])
        throw new Error('write failed')
    })
    await expect(f.request({ rejectOnFailure: true })).rejects.toThrow('write failed')
    await f.request({ rejectOnFailure: true })
    expect(f.save.mock.calls[1][0].chat).toEqual(expect.arrayContaining([['bot', 'first'], ['bot', 'second']]))
    expect(f.changeTracker.chat).toEqual([])
})

test('immediate saves reconcile live files once before writing and then await a canonical flush', async () => {
    const f = fixture()
    await f.request({ flushServer: 'canonical', rejectOnFailure: true })
    expect(f.sync).toHaveBeenCalledOnce()
    expect(f.save).toHaveBeenCalledOnce()
    expect(f.flush).toHaveBeenCalledWith(false, true, undefined)
    expect(f.sync.mock.invocationCallOrder[0]).toBeLessThan(f.save.mock.invocationCallOrder[0])
    expect(f.save.mock.invocationCallOrder[0]).toBeLessThan(f.flush.mock.invocationCallOrder[0])
})

test('an immediate save still refreshes external files when there are no local changes', async () => {
    const f = fixture(false)
    await f.request({ rejectOnFailure: true })
    expect(f.sync).toHaveBeenCalledOnce()
    expect(f.save).not.toHaveBeenCalled()
})

test('failed preflight prevents a write and failed flush rejects the save', async () => {
    const f = fixture()
    f.sync.mockRejectedValueOnce(new Error('external conflict'))
    await expect(f.request({ flushServer: 'canonical', rejectOnFailure: true })).rejects.toThrow('external conflict')
    expect(f.save).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    f.flush.mockRejectedValueOnce(new Error('disk full'))
    await expect(f.request({ flushServer: 'canonical', rejectOnFailure: true })).rejects.toThrow('disk full')
})
