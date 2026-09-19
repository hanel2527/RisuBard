import { afterAll, expect, test } from 'vitest'
import { cp, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
import { decodeRisuDat } from './helpers/normalize.js'
const { encodeRisuSaveLegacyBuffer } = require('../../server/node/utils.cjs')
const { atomicWriteJson } = require('../../server/node/file-store.cjs')
const { calculateHash } = require('../../server/node/utils.cjs')
const key = 'database/database.bin'
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })

test('preset and root-only edits defer the blob and survive SIGKILL with their full contents', async () => {
    const f = await fixture()
    const initialFull: any = decodeRisuDat(decodeBackup(await f.client.exportBackup()).find(entry => entry.name === 'database.risudat')!.data)
    let database: any = decodeRisuDat(Buffer.from(await (await f.client.fetch('/api/read', {
        headers: { ...f.headers, 'file-path': Buffer.from(key).toString('hex') },
    })).arrayBuffer()))
    const preset = { id: 'p1-preset', name: 'test', promptTemplate: [{ type: 'plain', text: 'edited block' }] }
    const edits = [
        [{ op: 'add', path: '/botPresets/-', value: preset }],
        [{ op: 'add', path: '/customCSS', value: 'body { color: red; }' }],
    ]
    for (let index = 0; index < edits.length; index++) {
        const response = await f.client.fetch('/api/patch', {
            method: 'POST', headers: { ...f.headers, 'file-path': Buffer.from(key).toString('hex'), 'content-type': 'application/json' },
            body: JSON.stringify({ patch: edits[index], expectedHash: calculateHash(database).toString(16) }),
        })
        expect(response.status, await response.clone().text()).toBe(200)
        if (index === 0) database.botPresets.push(preset)
        else database.customCSS = 'body { color: red; }'
        await expect.poll(async () => (await f.rows()).filter(row => row.kind === 'compatibility-persist' && row.trigger === 'patch-debounce').length,
            { timeout: 10000 }).toBe(index + 1)
        const rows = await f.rows()
        expect(rows.filter(row => row.kind === 'compatibility-persist').at(-1)).toMatchObject({ outcome: 'success', projectionDeferred: true })
        expect(rows.filter(row => row.kind === 'canonical-sync').at(-1)).toMatchObject({ strategy: 'bot-presets-direct', fallbackUsed: false })
        expect((await f.manifest()).entries[key]).toBeUndefined()
    }
    await f.server.stop('SIGKILL')
    const reopened = await spawnServer({ seedSave: save => cp(path.join(f.server.cwd, 'save'), save,
        { recursive: true, filter: source => path.basename(source) !== '.risubard-server.lock' }) }); servers.push(reopened)
    const client = await createClient(reopened.port, reopened.password)
    const restored: any = decodeRisuDat(decodeBackup(await client.exportBackup()).find(entry => entry.name === 'database.risudat')!.data)
    expect(restored).toEqual({ ...database, characters: initialFull.characters })
})

async function fixture(enabled = true) {
    const server = await spawnServer({ env: { RISUBARD_DEFER_DATABASE: enabled ? '1' : '0' } }); servers.push(server)
    const client = await createClient(server.port, server.password)
    const entries = decodeBackup(createSeedBackup({ characterCount: 2, chatsPerCharacter: 2 }))
    const database: any = decodeRisuDat(entries[0].data)
    database.modules=[]; database.loreBook=[]; database.personas[0].id='persona-1'
    entries[0].data = encodeRisuSaveLegacyBuffer(database)
    expect((await client.importBackup(encodeBackup(entries))).ok).toBe(true)
    const session = await client.fetch('/api/session', { method:'POST', headers:{'x-session-id':'p1-test'} })
    const headers = { 'x-session-id':'p1-test', 'x-user-active':'1', cookie:session.headers.get('set-cookie')!.split(';',1)[0] }
    expect((await client.fetch('/api/read', { headers:{...headers,'file-path':Buffer.from(key).toString('hex')} })).ok).toBe(true)
    const manifest = async () => JSON.parse(await readFile(path.join(server.cwd,'save/kv/manifest.json'),'utf8'))
    const rows = async () => (await readFile(path.join(server.cwd,'save/logs/storage-observation.jsonl'),'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line))
    const saveChat = async (data: string, count: number) => {
        expect((await client.fetch('/api/chat-content/test-char-0/0', { method:'POST', headers:{...headers,'content-type':'application/json','x-chat-id':'chat-0-0'}, body:JSON.stringify({id:'chat-0-0',name:'Chat 0',message:[{role:'user',data}],localLore:[]}) })).ok).toBe(true)
        const until=Date.now()+10000
        while(Date.now()<until) {
            const saves=(await rows()).filter(row=>row.kind==='compatibility-persist'&&row.trigger==='chat-debounce')
            if(saves.length>=count) { expect(saves.at(-1).outcome).toBe('success'); return saves.at(-1) }
            await new Promise(resolve=>setTimeout(resolve,50))
        }
        throw new Error('Deferred chat save timed out')
    }
    return {server,client,headers,manifest,rows,saveChat}
}

test('successive durable chat saves skip the blob until export, then restore the latest data', async () => {
    const f=await fixture()
    for(let i=1;i<=2;i++) {
        const save=await f.saveChat(`saved-${i}`,i)
        expect(save.projectionDeferred).toBe(true)
        expect(save.encodeMs).toBeUndefined(); expect(save.kvWriteMs).toBeUndefined()
        expect((await f.manifest()).entries[key]).toBeUndefined()
        expect(JSON.parse((await readFile(path.join(f.server.cwd,'save/characters/test-char-0/chats/chat-0-0/messages.jsonl'),'utf8')).trim()).data).toBe(`saved-${i}`)
    }
    const backup=await f.client.exportBackup()
    const database: any=decodeRisuDat(decodeBackup(backup).find(entry=>entry.name==='database.risudat')!.data)
    expect(database.characters[0].chats[0].message[0].data).toBe('saved-2')
    expect((await f.manifest()).entries[key].size).toBeGreaterThan(0)
    const restored=await spawnServer(); servers.push(restored)
    const client=await createClient(restored.port,restored.password)
    expect((await client.importBackup(backup)).ok).toBe(true)
    const roundtrip=decodeBackup(await client.exportBackup())
    expect(decodeRisuDat(roundtrip.find(entry=>entry.name==='database.risudat')!.data)).toEqual(database)
    const rows=await f.rows()
    expect(rows.some(row=>row.kind==='compatibility-materialize'&&row.outcome==='success')).toBe(true)
    expect(rows.filter(row=>row.kind==='projection-shadow').some(row=>['failure','mismatch'].includes(row.outcome))).toBe(false)
})

test('SIGKILL after a deferred commit recovers before the first backup request', async () => {
    const f=await fixture(); await f.saveChat('survives-crash',1)
    expect((await f.manifest()).entries[key]).toBeUndefined()
    await f.server.stop('SIGKILL')
    const reopened=await spawnServer({seedSave:save=>cp(path.join(f.server.cwd,'save'),save,{recursive:true,filter:source=>path.basename(source)!=='.risubard-server.lock'})}); servers.push(reopened)
    const client=await createClient(reopened.port,reopened.password)
    const exported=decodeBackup(await client.exportBackup())
    const database:any=decodeRisuDat(exported.find(entry=>entry.name==='database.risudat')!.data)
    expect(database.characters[0].chats[0].message[0].data).toBe('survives-crash')
})

test('explicit flush materializes and the disable switch retains immediate compatibility writes', async () => {
    const f=await fixture(); await f.saveChat('flush-me',1)
    expect((await f.manifest()).entries[key]).toBeUndefined()
    const root=path.join(f.server.cwd,'save')
    const settings=JSON.parse(await readFile(path.join(root,'settings/app.json'),'utf8'))
    atomicWriteJson(root,'settings/app.json',{...settings,customCSS:'body { color: blue; }'})
    expect((await f.client.fetch('/api/db/flush',{method:'POST',headers:f.headers})).ok).toBe(true)
    expect((await f.manifest()).entries[key].size).toBeGreaterThan(0)
    const externalBackup=decodeBackup(await f.client.exportBackup())
    const external:any=decodeRisuDat(externalBackup.find(entry=>entry.name==='database.risudat')!.data)
    expect(external.customCSS).toBe('body { color: blue; }')
    expect(external.characters[0].chats[0].message[0].data).toBe('flush-me')
    const old=await fixture(false); const save=await old.saveChat('immediate',1)
    expect(save.projectionDeferred).not.toBe(true)
    expect((await old.manifest()).entries[key].size).toBeGreaterThan(0)
})
