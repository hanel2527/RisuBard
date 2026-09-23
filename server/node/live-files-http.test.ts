import { expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { encodeRisuSaveLegacyBuffer, decodeRisuSave } = require('./utils.cjs')

test('running server adopts editor saves and asset changes through authenticated sync without reloading', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-live-http-'))
    const dataRoot = path.join(root, 'save')
    const repository = createUserDataRepository({ dataRoot })
    const database = { language: 'en', botPresets: [], modules: [], personas: [], loreBook: [], characters: [{
        chaId: 'one', type: 'character', name: 'One', desc: 'Before', globalLore: [{ key: 'world', content: 'Before' }], additionalAssets: [], emotionImages: [],
        chats: [{ id: 'chat', name: 'Chat', message: [{ role: 'user', data: 'Original message' }] }],
    }] }
    repository.importLegacyDatabase(database, { mode: 'sync' })
    const store = createFileKv({ dataRoot })
    store.kvSet('database/database.bin', encodeRisuSaveLegacyBuffer(database))
    store.kvSet('database/canonical-projection-revision', Buffer.from(repository.getProjectionRevision()))
    fs.writeFileSync(path.join(dataRoot, '__password'), 'local-test-password')
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
    try {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (child.exitCode !== null) throw new Error(logs)
            try { if ((await fetch(`${base}/api/test_auth`)).ok) break } catch {}
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'local-test-password' }) })
        expect(login.ok, logs).toBe(true)
        const { token } = await login.json()
        const headers = { 'content-type': 'application/json', 'risu-auth': token, 'x-session-id': 'live-test' }
        const sync = async (revision?: string) => {
            const response = await fetch(`${base}/api/live-files/sync`, { method: 'POST', headers, body: JSON.stringify({ revision }) })
            expect(response.ok, await response.clone().text()).toBe(true)
            return response.json()
        }
        const initial = await sync()
        expect(initial.snapshot.characters[0].desc).toBe('Before')
        const saved = await fetch(`${base}/api/chat-content/one/0`, {
            method: 'POST', headers: { ...headers, 'x-chat-id': 'chat' },
            body: JSON.stringify({ id: 'chat', name: 'Chat', message: [{ role: 'user', data: 'Acknowledged pending message' }] }),
        })
        expect(saved.ok, await saved.clone().text()).toBe(true)
        const metadata = path.join(dataRoot, 'characters/one/metadata.json')
        const value = JSON.parse(fs.readFileSync(metadata, 'utf8')); value.desc = 'Edited'; value.globalLore = []
        fs.writeFileSync(metadata, JSON.stringify(value))
        const assets = path.join(dataRoot, 'characters/one/assets'); fs.mkdirSync(assets)
        fs.writeFileSync(path.join(assets, 'smile.png'), 'image one')
        // Let the 5s debounce fail against the edited canonical file and remove
        // its timer. Acknowledged data must still be merged on the next sync.
        await new Promise(resolve => setTimeout(resolve, 5300))
        const edited = await sync(initial.revision)
        expect(edited.error).toBeUndefined()
        expect(edited.snapshot.characters[0]).toMatchObject({ desc: 'Edited', globalLore: [] })
        const firstKey = edited.snapshot.characters[0].additionalAssets[0][1]
        fs.writeFileSync(path.join(assets, 'smile.png'), 'image two')
        await new Promise(resolve => setTimeout(resolve, 300))
        const replaced = await sync(edited.revision)
        expect(replaced.snapshot.characters[0].additionalAssets[0][1]).not.toBe(firstKey)
        fs.writeFileSync(metadata, '{')
        await new Promise(resolve => setTimeout(resolve, 300))
        const invalid = await sync(replaced.revision)
        expect(invalid.error).toBeTruthy(); expect(invalid.snapshot).toBeUndefined()
        const repaired = { ...replaced.snapshot.characters[0], desc: 'Fixed' }
        fs.writeFileSync(metadata, JSON.stringify(repaired))
        fs.unlinkSync(path.join(assets, 'smile.png'))
        await new Promise(resolve => setTimeout(resolve, 300))
        const final = await sync(replaced.revision)
        expect(final.snapshot.characters[0]).toMatchObject({ desc: 'Fixed', additionalAssets: [] })
        const chatResponse = await fetch(`${base}/api/chat-content/one/0`, { headers: { ...headers, 'x-chat-id': 'chat' } })
        expect(chatResponse.ok).toBe(true)
        const chat = await decodeRisuSave(Buffer.from(await chatResponse.arrayBuffer()))
        expect(chat.message[0].data).toBe('Acknowledged pending message')
    } finally {
        child.kill()
        if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve))
        fs.rmSync(root, { recursive: true, force: true })
    }
}, 20000)
