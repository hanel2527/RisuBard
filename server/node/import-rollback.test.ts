import { expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { encodeRisuSaveLegacyBuffer } = require('./utils.cjs')

test.each(['unloaded', 'broken-plugin'])('rollback can recover safely from %s data', async scenario => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-import-rollback-'))
    const dataRoot = path.join(root, 'save')
    const repository = createUserDataRepository({ dataRoot })
    const database = { characters: [{ chaId: 'existing', name: 'Existing', chats: [
        scenario === 'unloaded' ? { id: 'chat', type: 'remote' } : { id: 'chat', message: [{ data: 'assets/existing' }] },
    ] }], modules: [] }
    repository.importLegacyDatabase(database)
    const store = createFileKv({ dataRoot })
    store.kvSet('database/database.bin', encodeRisuSaveLegacyBuffer(database))
    store.kvSet('database/canonical-projection-revision', Buffer.from(repository.getProjectionRevision()))
    store.kvSet('assets/new', Buffer.from('unfinished installation'))
    store.kvSet('assets/existing', Buffer.from('existing asset'))
    if (scenario === 'broken-plugin') store.kvSet('cache/plugin-storage/broken.json', Buffer.from('{'))
    fs.writeFileSync(path.join(dataRoot, '__password'), 'test-password')
    const reservation = net.createServer()
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const port = (reservation.address() as net.AddressInfo).port
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    const child = spawn(process.execPath, [path.join(process.cwd(), 'server/node/server.cjs')], {
        cwd: root, env: { ...process.env, RISUBARD_DATA_ROOT: dataRoot, PORT: String(port), OPEN_BROWSER: '0' },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let logs = ''
    child.stdout.on('data', value => { logs += value })
    child.stderr.on('data', value => { logs += value })
    const base = `http://127.0.0.1:${port}`
    const id = '12345678-1234-1234-1234-123456789abc'
    const marker = 'cache/import-rollback/' + id
    try {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (child.exitCode !== null) throw new Error(logs)
            try { if ((await fetch(`${base}/api/test_auth`)).ok) break } catch {}
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) })
        expect(login.ok, logs).toBe(true)
        const { token } = await login.json()
        const headers = { 'content-type': 'application/json', 'risu-auth': token, 'x-session-id': 'rollback-test' }
        const post = (suffix: string, body: unknown) => fetch(`${base}/api/assets/import-rollback${suffix}`, { method: 'POST', headers, body: JSON.stringify(body) })
        expect((await post('/prepare', { id })).ok).toBe(true)
        const ordinary = await post('', { id, keys: ['assets/new'] })
        if (scenario === 'unloaded') {
            expect(ordinary.status, await ordinary.clone().text()).toBe(200)
            expect(await ordinary.json()).toMatchObject({ count: 0, retained: 1 })
        } else {
            expect(ordinary.status).toBe(500)
            expect(createFileKv({ dataRoot }).kvGet(marker)).not.toBeNull()
        }
        expect((await post('/prepare', { id })).ok).toBe(true)
        expect((await post('', { id, keys: ['../existing'], retainAssets: true })).status).toBe(400)
        expect(createFileKv({ dataRoot }).kvGet(marker)).not.toBeNull()
        const reset = await post('', { id, keys: ['assets/new'], retainAssets: true })
        expect(reset.status, await reset.clone().text()).toBe(200)
        expect(await reset.json()).toMatchObject({ ok: true, count: 0, reclaimed: 0, retained: 1 })
        const reopened = createFileKv({ dataRoot })
        expect(reopened.kvGet(marker)).toBeNull()
        expect(reopened.kvGet('assets/new').toString()).toBe('unfinished installation')
        expect(reopened.kvGet('assets/existing').toString()).toBe('existing asset')
        expect(repository.exportLegacyDatabase().characters).toEqual(database.characters)
        expect((await post('', { id, keys: ['assets/new'], retainAssets: true })).ok).toBe(true)
    } finally {
        child.kill()
        if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve))
        fs.rmSync(root, { recursive: true, force: true })
    }
}, 20000)
