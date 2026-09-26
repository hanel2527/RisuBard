import { expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { encodeRisuSaveLegacyBuffer, decodeRisuSave } = require('./utils.cjs')

test.each(['legacy', 'v3'])('running server adopts editor saves, chat lore deletion and assets without reloading: %s', async (layout) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-live-http-'))
    const dataRoot = path.join(root, 'save')
    const repository = createUserDataRepository({ dataRoot, allowDirectoryMapping: true, newCharacterPackages: layout === 'v3' })
    const database = { language: 'en', botPresets: [], modules: [], personas: [], loreBook: [], characters: [{
        chaId: 'one', type: 'character', name: 'One', desc: 'Before', globalLore: [{ key: 'world', content: 'Before' }], additionalAssets: [], emotionImages: [],
        chats: [
            { id: 'chat', name: 'Chat', localLore: [{ key: 'local', content: 'Delete this' }], message: [{ role: 'user', data: 'Original message' }] },
            { id: '', name: 'Legacy chat', localLore: [], message: [{ role: 'user', data: 'Preserved legacy message' }] },
        ],
    }] }
    repository.importLegacyDatabase(database, { mode: 'sync' })
    const resolver = require('./character-directories.cjs').createCharacterDirectoryResolver(dataRoot)
    const characterPath = resolver.characterDirectory('one')
    const chatPath = resolver.chatDirectory('one', 'chat')
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
        // A poll after server restart must work before the compatibility reader
        // assigns IDs, without publishing an unaddressable chat or migrating data.
        expect(initial.snapshot.chatMetadata.map((entry: any) => entry.chatId)).toEqual(['chat'])
        expect(repository.exportLegacyDatabase()).toEqual(database)
        const unchanged = await sync(initial.revision)
        expect(unchanged.error).toBeUndefined()
        expect(unchanged.snapshot).toBeUndefined()
        const monitoringUrl = `${base}/api/live-files/monitoring`
        const noAuth = await fetch(monitoringUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
        expect(noAuth.ok).toBe(false)
        const malformed = await fetch(monitoringUrl, { method: 'POST', headers, body: JSON.stringify({ enabled: 'false' }) })
        expect(malformed.status).toBe(400)
        const disabled = await fetch(monitoringUrl, { method: 'POST', headers, body: JSON.stringify({ enabled: false }) })
        expect(disabled.ok, await disabled.clone().text()).toBe(true)
        expect((await disabled.json()).enabled).toBe(false)
        expect((await (await fetch(monitoringUrl, { headers })).json()).enabled).toBe(false)
        const noSync = await sync(initial.revision)
        expect(noSync.enabled).toBe(false)
        expect(noSync.snapshot).toBeUndefined()
        const bulk = await fetch(`${base}/api/assets/bulk-write`, { method: 'POST', headers, body: JSON.stringify([{ key: 'assets/disabled-test.png', value: Buffer.from('asset while disabled').toString('base64') }]) })
        expect(bulk.ok, await bulk.clone().text()).toBe(true)
        const asset = await fetch(`${base}/api/read`, { headers: { ...headers, 'file-path': Buffer.from('assets/disabled-test.png').toString('hex') } })
        expect(await asset.text()).toBe('asset while disabled')
        const saved = await fetch(`${base}/api/chat-content/one/0`, {
            method: 'POST', headers: { ...headers, 'x-chat-id': 'chat' },
            body: JSON.stringify({ id: 'chat', name: 'Chat', localLore: database.characters[0].chats[0].localLore, message: [{ role: 'user', data: 'Acknowledged pending message' }] }),
        })
        expect(saved.ok, await saved.clone().text()).toBe(true)
        const session = await fetch(`${base}/api/session`, { method: 'POST', headers })
        const cookie = session.headers.get('set-cookie')!.split(';')[0]
        const flushed = await fetch(`${base}/api/db/flush`, { method: 'POST', headers: { ...headers, cookie } })
        expect(flushed.ok, await flushed.clone().text()).toBe(true)
        expect(fs.readFileSync(path.join(dataRoot, chatPath, 'messages.jsonl'), 'utf8')).toContain('Acknowledged pending message')
        const enabled = await fetch(monitoringUrl, { method: 'POST', headers, body: JSON.stringify({ enabled: true }) })
        expect(enabled.ok, await enabled.clone().text()).toBe(true)
        expect((await fetch(`${base}/api/live-files/events`)).status).toBe(401)
        const eventAbort = new AbortController()
        const events = await fetch(`${base}/api/live-files/events`, { headers: { cookie }, signal: eventAbort.signal })
        expect(events.headers.get('content-type')).toContain('text/event-stream')
        const reader = events.body!.getReader()
        let eventBuffer = ''
        const readEvent = async () => {
            for (;;) {
                const boundary = eventBuffer.indexOf('\n\n')
                if (boundary >= 0) {
                    const frame = eventBuffer.slice(0, boundary)
                    eventBuffer = eventBuffer.slice(boundary + 2)
                    const data = frame.split('\n').find(line => line.startsWith('data: '))
                    if (data) return JSON.parse(data.slice(6))
                    continue
                }
                const chunk = await reader.read()
                if (chunk.done) throw new Error('Event stream ended before notification')
                eventBuffer += new TextDecoder().decode(chunk.value)
            }
        }
        expect(await readEvent()).toMatchObject({ reason: 'ready', enabled: true })
        const metadata = path.join(dataRoot, characterPath, 'metadata.json')
        const value = JSON.parse(fs.readFileSync(metadata, 'utf8')); value.desc = 'Edited'; value.globalLore = []
        const eventTimeout = setTimeout(() => eventAbort.abort(), 5000)
        try {
            fs.writeFileSync(metadata, JSON.stringify(value))
            expect(await readEvent()).toEqual({ reason: 'change', enabled: true, defaultEnabled: true })
        } finally {
            clearTimeout(eventTimeout)
            eventAbort.abort()
            await reader.cancel().catch(() => {})
        }
        const assets = path.join(dataRoot, characterPath, 'assets'); fs.mkdirSync(assets, { recursive: true })
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
        const chatFile = path.join(dataRoot, chatPath, 'metadata.json')
        const chatMetadata = JSON.parse(fs.readFileSync(chatFile, 'utf8'))
        delete chatMetadata.localLore
        fs.writeFileSync(chatFile, JSON.stringify(chatMetadata))
        await new Promise(resolve => setTimeout(resolve, 300))
        const loreRemoved = await sync(final.revision)
        expect(loreRemoved.error).toBeUndefined()
        const entry = loreRemoved.snapshot.chatMetadata.find((entry: any) => entry.chatId === 'chat')
        expect(entry.metadata.localLore).toBeUndefined()
        expect(entry.previous.localLore).toHaveLength(1)
        const editedChat = await fetch(`${base}/api/chat-content/one/0`, { headers: { ...headers, 'x-chat-id': 'chat' } })
        const editedValue = await decodeRisuSave(Buffer.from(await editedChat.arrayBuffer()))
        expect(editedValue.localLore ?? []).toEqual([])
        expect(editedValue.message[0].data).toBe('Acknowledged pending message')
        fs.writeFileSync(chatFile, JSON.stringify({ ...chatMetadata, note: 'External note' }))
        const read = await fetch(`${base}/api/read`, { headers: { ...headers, 'file-path': Buffer.from('database/database.bin').toString('hex') } })
        expect(read.status, await read.clone().text()).toBe(200)
        const loaded = await decodeRisuSave(Buffer.from(await read.arrayBuffer()))
        const legacyId = loaded.characters[0].chats[1].id
        expect(legacyId).toEqual(expect.any(String))
        expect(legacyId.length).toBeGreaterThan(0)
        const legacyChat = await fetch(`${base}/api/chat-content/one/1`, { headers: { ...headers, 'x-chat-id': legacyId } })
        expect(legacyChat.ok).toBe(true)
        expect(await decodeRisuSave(Buffer.from(await legacyChat.arrayBuffer()))).toMatchObject({
            id: legacyId, name: 'Legacy chat', message: [{ role: 'user', data: 'Preserved legacy message' }],
        })
    } finally {
        child.kill()
        if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve))
        fs.rmSync(root, { recursive: true, force: true })
    }
}, 20000)
