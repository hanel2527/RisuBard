import { afterAll, expect, test } from 'vitest'
import { cp, readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
import { normalizeBackup } from './helpers/normalize.js'

const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })

test('imports old backups containing generated inlay checksums without treating them as images', async () => {
  const source = await spawnServer()
  servers.push(source)
  const client = await createClient(source.port, source.password)
  expect((await client.importBackup(createSeedBackup({ characterCount: 1 }))).ok).toBe(true)
  const entries = decodeBackup(await client.exportBackup())
  entries.push({ name: 'inlay/.migrated_to_fs.sha256', data: Buffer.from('a'.repeat(64)) })
  entries.push({ name: 'inlay/picture.png', data: Buffer.from('image-payload') })
  entries.push({ name: 'inlay/picture.png.sha256', data: Buffer.from('b'.repeat(64)) })
  entries.push({ name: 'inlay/picture.meta.json.sha256', data: Buffer.from('c'.repeat(64)) })
  const destination = await spawnServer()
  servers.push(destination)
  const restored = await createClient(destination.port, destination.password)
  const result = await restored.importBackup(encodeBackup(entries))
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
  expect(await readFile(path.join(destination.cwd, 'save/inlays/picture.png'), 'utf8')).toBe('image-payload')
  const exported = decodeBackup(await restored.exportBackup())
  expect(exported.filter(entry => entry.name.startsWith('inlay/')).map(entry => entry.name)).toEqual(['inlay/picture.png'])
})

test.each([0, 2])('repeated self restore preserves %i characters and settings after a server restart', async (characterCount) => {
  const server = await spawnServer()
  servers.push(server)
  const client = await createClient(server.port, server.password)
  expect((await client.importBackup(createSeedBackup({ characterCount, chatsPerCharacter: 2 }))).ok).toBe(true)
  const original = normalizeBackup(await client.exportBackup())
  function expectPreserved(backup: Buffer) {
    const restored = normalizeBackup(backup)
    // Startup adds empty canonical collections and IDs absent from legacy data.
    expect(restored.normalized).toEqual({
      ...original.normalized,
      settingKeys: expect.arrayContaining(original.normalized.settingKeys),
    })
    // Match every existing value, allowing only extra object fields such as IDs.
    // Array lengths still have to match, so missing or duplicate entities fail.
    expect(restored.raw).toMatchObject(original.raw)
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const backup = await client.exportBackup()
    expect(decodeBackup(backup).filter(entry => entry.name.startsWith('inlay/')).map(entry => entry.name)).toEqual([])
    const result = await client.importBackup(backup)
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    expectPreserved(await client.exportBackup())
  }
  await server.stop()
  const restarted = await spawnServer({ seedSave: save => cp(path.join(server.cwd, 'save'), save, { recursive: true }) })
  servers.push(restarted)
  const restartedClient = await createClient(restarted.port, restarted.password)
  expectPreserved(await restartedClient.exportBackup())
})
