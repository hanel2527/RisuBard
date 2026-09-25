import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, test, vi } from 'vitest'

// Exercise the actual runtime response handler without mounting the application.
const source = readFileSync(resolve(process.cwd(), 'src/ts/globalApi.svelte.ts'), 'utf8')
const start = source.indexOf('    async function syncLiveFilesNow()')
const end = source.indexOf('    const refreshThisRuntime =', start)
const handler = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })

test('an error with a newer revision cannot consume the unseen snapshot revision', async () => {
    const response = { revision: 'new', etag: 'etag', error: 'External files are being saved; retry in a moment' }
    const syncLiveFiles = vi.fn(async () => response)
    const create = new Function('forageStorage', `
        let liveRevision = 'old', lastLiveError = '', gotChannel = false;
        const supportsPatchSync = true, saveRuntime = { isActive: () => true }, notifyError = () => {};
        ${handler}
        return { sync: syncLiveFilesNow, revision: () => liveRevision };
    `)
    const runtime = create({ syncLiveFiles })
    await expect(runtime.sync()).rejects.toThrow('External files are being saved')
    expect(runtime.revision()).toBe('old')
    await expect(runtime.sync()).rejects.toThrow('External files are being saved')
    expect(syncLiveFiles).toHaveBeenLastCalledWith('old')
})

test('send preflight failure is a visible false result before any generation starts', async () => {
    const sendSource = readFileSync(resolve(process.cwd(), 'src/ts/process/index.svelte.ts'), 'utf8')
    const sendStart = sendSource.indexOf('export async function sendChat(')
    const bodyMarker = '} = {}):Promise<boolean> {'
    const bodyStart = sendSource.indexOf(bodyMarker, sendStart) + bodyMarker.length
    const bodyEnd = sendSource.indexOf('    const selected =', bodyStart)
    const preflight = ts.transpile(`async function preflight() { ${sendSource.slice(bodyStart, bodyEnd)}; return true }`, { target: ts.ScriptTarget.ES2022 })
    const notifyError = vi.fn()
    const create = new Function('refreshLiveFiles', 'notifyError', `${preflight}; return preflight`)
    const run = create(async () => { throw new Error('writer inactive') }, notifyError)
    await expect(run()).resolves.toBe(false)
    expect(notifyError).toHaveBeenCalledOnce()
})
