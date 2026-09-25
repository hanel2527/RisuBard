import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { createSessionHandoff } from './sessionHandoff'

const source = readFileSync('src/ts/globalApi.svelte.ts', 'utf8')
const start = source.indexOf('    let changed = false', source.indexOf('export async function saveDb()'))
const end = source.indexOf('    const changeTracker:', start)
const wiring = ts.transpile(source.slice(start, end).replace(
    'await import("./process/index.svelte")', '({ doingChat: false })',
), { target: ts.ScriptTarget.ES2022 })

it.each(['risu-session-deactivated', 'focus', 'broadcast'])('%s cannot discard local work by reloading', async (event) => {
    const target = new EventTarget() as EventTarget & { BroadcastChannel: unknown }
    let channel: any
    target.BroadcastChannel = class { onmessage: any; close() {} ; constructor() { channel = this } }
    const reload = vi.fn()
    const choose = vi.fn(async () => -1)
    const paused = vi.fn()
    const cleanups: (() => void)[] = []
    const env = {
        window: target, BroadcastChannel: target.BroadcastChannel,
        document: Object.assign(new EventTarget(), { visibilityState: 'visible', hidden: false }),
        location: { reload }, sessionStorage: { getItem: () => null, setItem() {} },
        globalThis: {}, v4: () => 'this-tab', getDatabase: () => ({ characters: [] }),
        claimSaveDbRuntime: async () => ({ isActive: () => true, addCleanup: (fn: () => void) => cleanups.push(fn) }),
        createCanonicalSaveConflict: () => ({}), createSessionHandoff,
        externalEditMode: {}, forageStorage: { getWriterLockState: async () => 'stale' },
        get: (value: unknown) => value, tick: async () => {},
        language: new Proxy({}, { get: (_, key) => String(key) }),
        alertNormalWait: async () => {}, alertConfirmMulti: choose, alertConfirm: async () => false,
        notifyInfo: vi.fn(), notifyError: paused, downloadFile: vi.fn(), supportsPatchSync: true,
    }
    const run = new Function('env', `return (async () => { const { ${Object.keys(env).join(',')} } = env; ${wiring} })()`)
    await run(env)
    if (event === 'broadcast') channel.onmessage({ data: 'another-tab' })
    else target.dispatchEvent(new Event(event))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(reload).not.toHaveBeenCalled()
    expect(choose).toHaveBeenCalledOnce()
    expect(paused).toHaveBeenCalledOnce()
    const unload = new Event('beforeunload', { cancelable: true })
    target.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    cleanups.forEach(fn => fn())
})

it('send preflight rejects even when polling is disabled after a handoff', async () => {
    const begin = source.indexOf('    const refreshThisRuntime =')
    const finish = source.indexOf('    let pollPending', begin)
    const refreshWiring = ts.transpile(source.slice(begin, finish), { target: ts.ScriptTarget.ES2022 })
    const run = new Function(`
        let gotChannel = true, refreshLiveFilesImpl = null, saveInFlight = null;
        const language = {sessionSavePausedTitle: 'Saving paused'};
        const supportsPatchSync = true, saveRuntime = {isActive: () => true};
        const syncLiveFilesNow = async () => {};
        const createLiveFileRefresh = hooks => async () => { if (hooks.isActive()) await hooks.sync(); };
        ${refreshWiring}
        return refreshLiveFilesImpl;
    `)
    await expect(run()()).rejects.toThrow('Saving paused')
})

it('ignores a delayed sync snapshot after the session has been paused', async () => {
    const begin = source.indexOf('    async function syncLiveFilesNow()')
    const finish = source.indexOf('    const refreshThisRuntime =', begin)
    const syncCode = ts.transpile(source.slice(begin, finish), { target: ts.ScriptTarget.ES2022 })
    let complete!: (value: unknown) => void
    const response = new Promise(resolve => { complete = resolve })
    const apply = vi.fn(() => { throw new Error('remote snapshot applied after pause') })
    const create = new Function('response', 'applyLiveFileSnapshot', `
        const supportsPatchSync = true, saveRuntime = {isActive: () => true};
        let gotChannel = false, liveRevision, acknowledgedDb = {}, liveChatMetadataBaseline = new Map();
        const language = {sessionSavePausedTitle: 'Saving paused'};
        const forageStorage = {syncLiveFiles: () => response}, getDatabase = () => ({});
        ${syncCode}
        return {sync: syncLiveFilesNow, pause: () => {gotChannel = true}};
    `)
    const state = create(response, apply)
    const syncing = state.sync()
    state.pause()
    complete({snapshot: {characters: []}, revision: 'old-response'})
    await expect(syncing).rejects.toThrow('Saving paused')
    expect(apply).not.toHaveBeenCalled()
})
