import { expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { encodeRisuSaveLegacyBuffer, decodeRisuSave, calculateHash } = require('./utils.cjs')
const { atomicWriteJson } = require('./file-store.cjs')

test.each(['missing', 'stale'])('Termux can save after recovering a %s accepted projection revision with monitoring off', async revisionState => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-termux-revision-'))
    const dataRoot = path.join(root, 'save')
    const repository = createUserDataRepository({ dataRoot })
    const database = {
        language: 'en', botPresets: [], modules: [], personas: [], loreBook: [],
        characters: [{ chaId: 'one', type: 'character', name: 'One', desc: 'Canonical description',
            chats: [{ id: 'chat', name: 'Chat', message: [{ role: 'user', data: 'Keep this message' }] }] }],
    }
    repository.importLegacyDatabase(database, { mode: 'sync' })
    const store = createFileKv({ dataRoot })
    // Compatibility data can lag behind the canonical files after an update or recovery.
    const staleDatabase = structuredClone(database)
    staleDatabase.characters[0].desc = 'Old cached description'
    store.kvSet('database/database.bin', encodeRisuSaveLegacyBuffer(staleDatabase))
    if (revisionState === 'stale') {
        atomicWriteJson(dataRoot, 'cache/canonical-projection-revision.json', { schemaVersion: 1, revision: '0'.repeat(64) })
    }
    fs.writeFileSync(path.join(dataRoot, '__password'), 'local-test-password')
    const reservation = net.createServer()
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const port = (reservation.address() as net.AddressInfo).port
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    const child = spawn(process.execPath, [path.join(process.cwd(), 'server/node/server.cjs')], {
        cwd: root,
        env: { ...process.env, PREFIX: '/data/data/com.termux/files/usr', RISUBARD_DATA_ROOT: dataRoot, PORT: String(port), OPEN_BROWSER: '0' },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let logs = ''
    child.stdout.on('data', value => { logs += value })
    child.stderr.on('data', value => { logs += value })
    const base = `http://127.0.0.1:${port}`
    try {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (child.exitCode !== null) throw new Error(logs)
            try { if ((await fetch(`${base}/api/test_auth`)).ok) break } catch {}
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'local-test-password' }) })
        expect(login.ok, logs).toBe(true)
        const { token } = await login.json()
        const headers = { 'content-type': 'application/json', 'risu-auth': token, 'x-session-id': 'termux-test' }
        const monitoring = () => fetch(`${base}/api/live-files/monitoring`, { headers }).then(r => r.json())
        expect(await monitoring()).toEqual({ enabled: false, defaultEnabled: false })
        const read = await fetch(`${base}/api/read`, { headers: { ...headers, 'file-path': Buffer.from('database/database.bin').toString('hex') } })
        expect(read.ok, await read.clone().text()).toBe(true)
        const loaded = await decodeRisuSave(Buffer.from(await read.arrayBuffer()))
        expect(loaded.characters[0].desc).toBe('Canonical description')
        const patched = await fetch(`${base}/api/patch`, {
            method: 'POST', headers: { ...headers, 'file-path': Buffer.from('database/database.bin').toString('hex') },
            body: JSON.stringify({ expectedHash: calculateHash(loaded).toString(16), patch: [{ op: 'replace', path: '/language', value: 'ko' }] }),
        })
        expect(patched.ok, await patched.clone().text()).toBe(true)
        const saved = await fetch(`${base}/api/chat-content/one/0`, {
            method: 'POST', headers: { ...headers, 'x-chat-id': 'chat' },
            body: JSON.stringify({ id: 'chat', name: 'Chat', message: [
                { role: 'user', data: 'Keep this message' }, { role: 'assistant', data: 'New saved message' },
            ] }),
        })
        expect(saved.ok, await saved.clone().text()).toBe(true)
        const session = await fetch(`${base}/api/session`, { method: 'POST', headers })
        const cookie = session.headers.get('set-cookie')!.split(';')[0]
        const flushed = await fetch(`${base}/api/db/flush`, { method: 'POST', headers: { ...headers, cookie } })
        expect(flushed.ok, await flushed.clone().text()).toBe(true)
        const disk = createUserDataRepository({ dataRoot }).exportLegacyDatabase()
        expect(disk.language).toBe('ko')
        expect(disk.characters[0].desc).toBe('Canonical description')
        expect(disk.characters[0].chats[0]).toMatchObject({ name: 'Chat', message: [
            { role: 'user', data: 'Keep this message' }, { role: 'assistant', data: 'New saved message' },
        ] })
        expect(await monitoring()).toEqual({ enabled: false, defaultEnabled: false })

        // Polls stay off, but an actual save must preserve validated disk changes.
        const metadataPath = path.join(dataRoot, 'characters/one/metadata.json')
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
        atomicWriteJson(dataRoot, 'characters/one/metadata.json', { ...metadata, desc: 'External description' })
        const poll = await fetch(`${base}/api/live-files/sync`, { method: 'POST', headers, body: '{}' })
        expect(await poll.json()).toMatchObject({ enabled: false })
        const write = () => fetch(`${base}/api/write`, {
            method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'file-path': Buffer.from('database/database.bin').toString('hex') },
            body: encodeRisuSaveLegacyBuffer(disk),
        })
        const conflict = await write()
        expect(conflict.status).toBe(409)
        expect(await conflict.json()).toMatchObject({ code: 'CANONICAL_FILES_CHANGED' })
        expect(JSON.parse(fs.readFileSync(metadataPath, 'utf8')).desc).toBe('External description')

        // Invalid editor bytes must neither be accepted nor overwritten by recovery.
        const acceptedPath = path.join(dataRoot, 'cache/canonical-projection-revision.json')
        const accepted = fs.readFileSync(acceptedPath, 'utf8')
        fs.writeFileSync(metadataPath, '{incomplete')
        expect((await write()).ok).toBe(false)
        expect(fs.readFileSync(metadataPath, 'utf8')).toBe('{incomplete')
        expect(fs.readFileSync(acceptedPath, 'utf8')).toBe(accepted)
    } finally {
        child.kill()
        if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve))
        // Only the temporary fixture created above is removed.
        fs.rmSync(root, { recursive: true, force: true })
    }
}, 20000)
