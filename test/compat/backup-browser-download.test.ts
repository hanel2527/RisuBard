import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

describe('browser-managed backup downloads', () => {
  let server: ServerHandle
  let client: RisuClient
  let cookie: string
  let base: string

  beforeAll(async () => {
    server = await spawnServer()
    client = await createClient(server.port, server.password)
    base = `http://127.0.0.1:${server.port}`
    await client.importBackup(createSeedBackup({ characterCount: 1 }))
    const session = await client.fetch('/api/session', { method: 'POST' })
    expect(session.ok).toBe(true)
    cookie = session.headers.get('set-cookie')!.split(';')[0]
  })

  afterAll(async () => { await server?.cleanup() })

  test.each(['', '?target=upstream', '?mode=settings&moduleAssets=0'])(
    'exports with only the HttpOnly session cookie: %s', async query => {
      const expected = await client.fetch('/api/backup/export' + query)
      expect(expected.ok).toBe(true)
      const bytes = new Uint8Array(await expected.arrayBuffer())
      const response = await fetch(base + '/api/backup/export' + query, { headers: { cookie } })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-disposition')).toContain('attachment;')
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(Number(response.headers.get('content-length'))).toBe(bytes.length)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    },
  )

  test('rejects unauthenticated and invalid-cookie export requests', async () => {
    for (const headers of [{}, { cookie: 'risu-session=invalid' }]) {
      const response = await fetch(base + '/api/backup/export', { headers })
      expect(response.ok).toBe(false)
      expect(response.headers.get('content-disposition')).toBeNull()
    }
  })

  test('does not extend cookie-only authentication to backup mutations', async () => {
    const response = await fetch(base + '/api/backup/import/prepare', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ size: 1 }),
    })
    expect(response.ok).toBe(false)
  })

  test('returns a failure instead of an attachment for a missing saved backup', async () => {
    const response = await fetch(base + '/api/backup/server/download/risu-backup-0.bin', { headers: { cookie } })
    expect(response.status).toBe(404)
    expect(response.headers.get('content-disposition')).toBeNull()
  })

  test('downloads an existing server backup with the cookie, but not without it', async () => {
    const save = await client.fetch('/api/backup/server/save', { method: 'POST' })
    const events = (await save.text()).trim().split('\n').map(line => JSON.parse(line))
    const done = events.find(event => event.type === 'done')
    expect(done?.ok).toBe(true)
    const url = base + '/api/backup/server/download/' + encodeURIComponent(done.filename)
    expect((await fetch(url)).ok).toBe(false)
    const response = await fetch(url, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain(done.filename)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect((await response.arrayBuffer()).byteLength).toBe(done.size)
  })
})
