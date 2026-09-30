import { afterAll, expect, test } from 'vitest'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
import { normalizeBackup, decodeRisuDat } from './helpers/normalize.js'

const { encodeRisuSaveLegacyBuffer } = require('../../server/node/utils.cjs')
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })

test.each([
  { change: 'lore', roundTrip: false }, { change: 'deletion', roundTrip: false }, { change: 'empty', roundTrip: false },
  { change: 'lore', roundTrip: true }, { change: 'deletion', roundTrip: true }, { change: 'empty', roundTrip: true },
  { change: 'same-name-new-id', roundTrip: false },
])('upstream restore replaces canonical $change (round trip: $roundTrip) before and after restart', async ({ change, roundTrip }) => {
  const server = await spawnServer()
  servers.push(server)
  const client = await createClient(server.port, server.password)
  const original = normalizeBackup(createSeedBackup({ characterCount: 2 })).raw as any
  original.characters[0].name = '도라에몽(1)'
  original.characters[0].globalLore = [{ key: 'test', content: 'old lore' }]
  const backup = (database: unknown) => encodeBackup([
    { name: 'database.risudat', data: encodeRisuSaveLegacyBuffer(database) },
  ])
  expect(await client.importBackup(backup(original))).toMatchObject({ ok: true })
  const wikiPath = path.join('characters', 'test-char-1', 'wiki', 'kept.md')
  await mkdir(path.dirname(path.join(server.cwd, 'save', wikiPath)), { recursive: true })
  await writeFile(path.join(server.cwd, 'save', wikiPath), '# Retained wiki\n')
  // Export and reload first so the destination has both canonical and cached data.
  const previousExport = decodeBackup(await client.exportBackup())
  const incoming = structuredClone(original)
  if (change === 'lore') incoming.characters[0].globalLore[0].content = 'new lore'
  else if (change === 'deletion') incoming.characters.splice(0, 1)
  else if (change === 'empty') incoming.characters = []
  else {
    incoming.characters[0].chaId = 'pocket-character'
    incoming.characters[0].globalLore[0].content = 'new lore'
  }
  // Upstream retains unfamiliar flat entries as assets while rewriting its database.
  const imported = roundTrip ? encodeBackup(previousExport.map(entry => entry.name === 'database.risudat'
    ? { ...entry, data: encodeRisuSaveLegacyBuffer(incoming) } : entry)) : backup(incoming)
  expect(await client.importBackup(imported)).toMatchObject({ ok: true })

  async function check(reader: typeof client) {
    const response = await reader.fetch('/api/read', {
      headers: { 'file-path': Buffer.from('database/database.bin').toString('hex') },
    })
    expect(response.ok).toBe(true)
    const database = decodeRisuDat(Buffer.from(await response.arrayBuffer())) as any
    expect(database.characters.map((c: any) => c.chaId)).toEqual(incoming.characters.map((c: any) => c.chaId))
    if (change === 'lore' || change === 'same-name-new-id') expect(database.characters[0].globalLore).toEqual(incoming.characters[0].globalLore)
    expect(normalizeBackup(await reader.exportBackup()).raw).toMatchObject(incoming)
  }
  await check(client)
  if (roundTrip && change !== 'empty') {
    expect(await readFile(path.join(server.cwd, 'save', wikiPath), 'utf8')).toBe('# Retained wiki\n')
  }
  await server.stop()
  const restarted = await spawnServer({ seedSave: save => cp(path.join(server.cwd, 'save'), save, { recursive: true }) })
  servers.push(restarted)
  await check(await createClient(restarted.port, restarted.password))
})
