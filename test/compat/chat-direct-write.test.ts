import { afterAll, expect, test } from 'vitest'
import { cp, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { decodeBackup } from './helpers/decode.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeRisuDat } from './helpers/normalize.js'

const { calculateHash, encodeRisuSaveLegacyBuffer } = require('../../server/node/utils.cjs')
const filePath = Buffer.from('database/database.bin').toString('hex')
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })

async function setup() {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const seed = decodeBackup(createSeedBackup({ characterCount: 2, chatsPerCharacter: 2, messagesPerChat: 3 }))
    const database: any = decodeRisuDat(seed[0].data)
    // Model the current application's initialized collections and stable IDs.
    // The legacy seed intentionally omits these for old-import compatibility tests.
    database.modules = []
    database.loreBook = []
    database.personas[0].id = 'persona-test'
    seed[0].data = encodeRisuSaveLegacyBuffer(database)
    expect((await client.importBackup(encodeBackup(seed))).ok).toBe(true)
    const session = 'w2-integration'
    const sessionResponse = await client.fetch('/api/session', { method: 'POST', headers: { 'x-session-id': session } })
    const cookie = sessionResponse.headers.get('set-cookie')!.split(';', 1)[0]
    const headers = { 'x-session-id': session, 'x-user-active': '1', cookie }
    const read = async () => {
        const response = await client.fetch('/api/read', { headers: { ...headers, 'file-path': filePath } })
        expect(response.ok).toBe(true)
        return decodeRisuDat(Buffer.from(await response.arrayBuffer())) as any
    }
    const postChat = async (id: string, data: string, chatIndex = 0) => {
        const response = await client.fetch(`/api/chat-content/test-char-0/${chatIndex}`, {
            method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-chat-id': id },
            body: JSON.stringify({ id, name: `Chat ${chatIndex}`, message: [{ role: 'user', data }], localLore: [] }),
        })
        expect(response.ok).toBe(true)
    }
    const patch = async (database: any, operations: any[]) => {
        const response = await client.fetch('/api/patch', {
            method: 'POST', headers: { ...headers, 'file-path': filePath, 'content-type': 'application/json' },
            body: JSON.stringify({ patch: operations, expectedHash: calculateHash(database).toString(16) }),
        })
        expect(response.status, await response.clone().text()).toBe(200)
    }
    const rows = async () => (await readFile(path.join(server.cwd, 'save/logs/storage-observation.jsonl'), 'utf8'))
        .trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    const waitFor = async (predicate: (rows: any[]) => boolean) => {
        const deadline = Date.now() + 12_000
        while (Date.now() < deadline) {
            const values = await rows()
            if (predicate(values)) return values
            await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error('W2 persist did not finish')
    }
    return { server, client, headers, read, postChat, patch, rows, waitFor }
}

test.each([true, false])('chat debounce persists canonical and compatibility data with cached=%s', async cached => {
    const fixture = await setup()
    if (cached) await fixture.read()
    await fixture.postChat('chat-0-0', 'first dirty chat')
    await fixture.postChat('chat-0-1', 'second dirty chat', 1)
    const rows = await fixture.waitFor(rows => rows.some(row => row.kind === 'canonical-sync' && row.trigger === 'chat-debounce'))
    expect(rows.find(row => row.kind === 'canonical-sync' && row.trigger === 'chat-debounce'))
        .toMatchObject({ outcome: 'success', strategy: 'chat-direct', fallbackUsed: false, plannedFiles: 6 })
    expect(rows.filter(row => row.kind === 'compatibility-persist').every(row => row.overlappingPersists === 0)).toBe(true)
    const backup = decodeBackup(await fixture.client.exportBackup())
    const database: any = decodeRisuDat(backup.find(entry => entry.name === 'database.risudat')!.data)
    for (const [index, text] of ['first dirty chat', 'second dirty chat'].entries()) {
        expect(database.characters[0].chats[index].message[0].data).toBe(text)
        const canonical = await readFile(path.join(fixture.server.cwd, `save/characters/test-char-0/chats/chat-0-${index}/messages.jsonl`), 'utf8')
        expect(JSON.parse(canonical.trim()).data).toBe(text)
    }
})

test('coalesced metadata and CSS survive restart; preset mixing, reordering and deletion use full sync', async () => {
    const fixture = await setup()
    let database = await fixture.read()
    await fixture.postChat('chat-0-0', 'durable edited message')
    await fixture.patch(database, [
        { op: 'replace', path: '/characters/0/chats/0/name', value: 'renamed chat' },
        { op: 'replace', path: '/characters/0/chatPage', value: 1 },
        { op: 'add', path: '/customCSS', value: 'body { color: red; }' },
    ])
    // Export must flush the same scope without waiting for the timer.
    await fixture.client.exportBackup()
    await fixture.waitFor(rows => rows.some(row => row.strategy === 'chat-direct'))
    const firstRows = await fixture.rows()
    expect(firstRows.find(row => row.strategy === 'chat-direct')).toMatchObject({ outcome: 'success', fallbackUsed: false })
    database = await fixture.read()
    await fixture.postChat('chat-0-1', 'mixed with preset', 1)
    await fixture.patch(database, [{ op: 'add', path: '/botPresets', value: [{ id: 'preset-test', name: 'test' }] }])
    await fixture.client.exportBackup()
    const mixedRows = await fixture.waitFor(rows => rows.filter(row => row.kind === 'canonical-sync').length > firstRows.filter(row => row.kind === 'canonical-sync').length)
    expect(mixedRows.filter(row => row.kind === 'canonical-sync').at(-1)).toMatchObject({ strategy: 'full-sync', outcome: 'success' })
    database = await fixture.read()
    await fixture.patch(database, [{ op: 'replace', path: '/characters/0/chats', value: [...database.characters[0].chats].reverse() }])
    await fixture.client.exportBackup()
    database = await fixture.read()
    await fixture.patch(database, [{ op: 'remove', path: '/characters/0/chats/1' }])
    const finalBackup = decodeBackup(await fixture.client.exportBackup())
    const expected: any = decodeRisuDat(finalBackup.find(entry => entry.name === 'database.risudat')!.data)
    expect(expected.customCSS).toBe('body { color: red; }')
    expect(expected.botPresets[0].name).toBe('test')
    expect(expected.characters[0].chats.map((chat: any) => chat.id)).toEqual(['chat-0-1'])
    expect(expected.characters[0].chats[0].message[0].data).toBe('mixed with preset')

    const restarted = await spawnServer({ seedSave: save => cp(path.join(fixture.server.cwd, 'save'), save, {
        recursive: true,
        // The clone is a different data root, not a second owner of the original.
        filter: source => path.basename(source) !== '.risubard-server.lock',
    }) })
    servers.push(restarted)
    const reopened = await createClient(restarted.port, restarted.password)
    const exported = decodeBackup(await reopened.exportBackup())
    expect(decodeRisuDat(exported.find(entry => entry.name === 'database.risudat')!.data)).toEqual(expected)
    const shadowRows = await fixture.waitFor(rows => rows.some(row => row.kind === 'projection-shadow' && row.outcome === 'success'))
    expect(shadowRows.filter(row => row.kind === 'projection-shadow').every(row => !['failure', 'mismatch'].includes(row.outcome))).toBe(true)
})
