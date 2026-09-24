import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, test, vi } from 'vitest'

vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))
const { RisuSavePatcher } = await import('./risuSave')
const { applyPatch } = await import('fast-json-patch')

// Execute the production retry controller without mounting the entire app.
// Transport uses the real patcher, so its eagerly advanced baseline is retained
// after a network failure, exactly as it is in the running save loop.
const source = readFileSync(resolve(process.cwd(), 'src/ts/globalApi.svelte.ts'), 'utf8')
const start = source.indexOf('    async function triggerSave(')
const end = source.indexOf('    requestImmediateSaveImpl =', start)
const controller = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })

test.each(['preflight', 'chat-write'] as const)('retains edits and stops retrying after a %s handoff', async (failure) => {
    const create = new Function(`
        let saveInFlight = null, savetrys = 0, changed = false, forceFullWriteOnRetry = false, gotChannel = false;
        const supportsPatchSync = true, saving = {}, lastLiveError = '';
        const saveRuntime = { isActive: () => true }, language = { sessionSavePausedTitle: 'Saving paused' };
        const changeTracker = { chat: [['character', 'chat']] };
        let requests = 0;
        const hasTrackedChanges = value => value.chat.length > 0;
        const takeTrackedChanges = () => { const result = {chat: [...changeTracker.chat]}; changeTracker.chat = []; return result; };
        const requeueTrackedChanges = value => { changeTracker.chat.push(...value.chat); };
        const rejectSession = () => { gotChannel = true; throw Object.assign(new Error('inactive'), {code: 'LIVE_FILES_INACTIVE'}); };
        const syncLiveFilesNow = async () => { requests++; if (${JSON.stringify(failure)} === 'preflight') rejectSession(); };
        const persistTrackedChanges = async () => { requests++; rejectSession(); };
        const sleep = async () => {}, alertError = () => {};
        ${controller}
        return { trigger: triggerSave, pending: () => changeTracker.chat, requests: () => requests };
    `)
    const state = create()
    await state.trigger()
    expect(state.pending()).toEqual([['character', 'chat']])
    const requests = state.requests()
    await state.trigger()
    await state.trigger()
    expect(state.requests()).toBe(requests)
    await expect(state.trigger({rejectOnFailure: true})).rejects.toThrow('Saving paused')
    expect(state.pending()).toEqual([['character', 'chat']])
})

test.each([
    ['network', false], ['noop', false], ['network', true],
] as const)('retains preset edits after %s (full retry also fails: %s)', async (failure, failFullRetry) => {
    const initial = {
        characters: [], modules: [], botPresetsId: 0,
        botPresets: [{ id: 'original', name: 'Original', promptTemplate: [{ text: 'ooc response' }] }],
    }
    const edited = structuredClone(initial)
    edited.botPresets.unshift({ id: 'copy', name: 'test', promptTemplate: [{ text: 'ooc response!' }] })
    let server = structuredClone(initial)
    const patcher = new RisuSavePatcher()
    await patcher.init(server)
    let attempts = 0
    let fullAttempts = 0
    const modes: string[] = []
    const persist = async (toSave: any, options: any) => {
        if (options?.forceFullWrite) {
            modes.push('full')
            if (failFullRetry && ++fullAttempts === 1) throw new Error('full write also failed')
            server = structuredClone(edited)
            await patcher.init(server)
            return 'saved'
        }
        modes.push('patch')
        const result = await patcher.set(edited, toSave)
        if (++attempts === 1) {
            expect(result.patch.length).toBeGreaterThan(0)
            if (failure === 'network') throw new Error('connection lost before server accepted patch')
            return 'noop'
        }
        server = applyPatch(server, result.patch).newDocument
        return 'saved'
    }
    const create = new Function('persistTrackedChanges', `
        let saveInFlight = null, savetrys = 0, changed = false, forceFullWriteOnRetry = false, gotChannel = false;
        const supportsPatchSync = true;
        const saveRuntime = { isActive: () => true }, externalEditMode = { active: false }, saving = {};
        const flags = { character: [], chat: [], root: true, botPreset: true, modules: false, plugins: false, pluginCustomStorage: false };
        let dirty = true;
        const changeTracker = { get root() { return dirty }, get botPreset() { return dirty } };
        const syncLiveFilesNow = async () => {}, lastLiveError = '';
        const takeTrackedChanges = () => { const value = dirty ? {...flags} : {...flags, root: false, botPreset: false}; dirty = false; return value; };
        const hasTrackedChanges = value => value.root || value.botPreset;
        const requeueTrackedChanges = () => { dirty = true; };
        const sleep = async () => {}, alertError = () => {}, console = { error() {} };
        ${controller}
        return { trigger: triggerSave, markDirty: () => { dirty = true; } };
    `)
    const { trigger, markDirty } = create(persist)
    await trigger()
    expect(server).toEqual(initial)
    await trigger()
    if (failFullRetry) {
        expect(server).toEqual(initial)
        await trigger()
    }
    expect(server).toEqual(edited)
    expect(modes).toEqual(failFullRetry ? ['patch', 'full', 'full'] : ['patch', 'full'])
    // Successful recovery restores the ordinary patch lane for later edits.
    edited.botPresets[0].promptTemplate[0].text += ' next edit'
    markDirty()
    await trigger()
    expect(server).toEqual(edited)
    expect(modes.at(-1)).toBe('patch')
})
