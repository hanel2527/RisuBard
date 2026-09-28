import { afterAll, describe, expect, test } from 'vitest'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeBackup } from './helpers/decode.js'
import { normalizeBackup } from './helpers/normalize.js'

const { decodeCanonicalBackupName } = require('../../server/node/canonical-backup-name.cjs')
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })

describe('backup export stability', () => {
    test('exports complete entries when a file grows after the inventory was measured', async () => {
        const server = await spawnServer({
            env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ./save/backup-read-race.cjs` },
            seedSave: async saveDir => {
                // Deterministically simulate a log append between stat and readFile.
                await writeFile(path.join(saveDir, 'backup-read-race.cjs'), `
const fs = require('node:fs/promises');
const originalRead = fs.readFile;
fs.readFile = async function(file, ...args) {
    if (String(file).endsWith('backup-race.log')) {
        await fs.appendFile(file, 'appended-after-inventory\\n');
    }
    return originalRead.call(this, file, ...args);
};
`)
            },
        })
        servers.push(server)
        const client = await createClient(server.port, server.password)
        expect((await client.importBackup(createSeedBackup({ characterCount: 1 }))).ok).toBe(true)
        const log = path.join(server.cwd, 'save/logs/backup-race.log')
        await mkdir(path.dirname(log), { recursive: true })
        await writeFile(log, 'before-inventory\n')

        const backup = await client.exportBackup()
        // Verify the real importer, including its exact reported truncation error.
        const restored = await client.importBackup(backup)
        expect(restored).toMatchObject({ ok: true })
        const entries = decodeBackup(backup)
        expect(entries.at(-1)?.name).toBe('database.risudat')
        expect(entries.find(entry => decodeCanonicalBackupName(entry.name) === 'logs/backup-race.log')?.data.toString())
            .toBe('before-inventory\nappended-after-inventory\n')
    })

    test('repeated self restore does not re-export recovery copies or multiply the backup size', async () => {
        const server = await spawnServer()
        servers.push(server)
        const client = await createClient(server.port, server.password)
        expect((await client.importBackup(createSeedBackup({ characterCount: 1, includeAssets: true }))).ok).toBe(true)
        const document = path.join(server.cwd, 'save/risubard/wiki/notes/story.md')
        const contents = Buffer.alloc(256 * 1024, 0x61)
        await mkdir(path.dirname(document), { recursive: true })
        await writeFile(document, contents)
        let backup = await client.exportBackup()
        const baselineSize = backup.length
        const original = normalizeBackup(backup).normalized.characters

        for (let round = 0; round < 3; round++) {
            expect((await client.importBackup(backup)).ok).toBe(true)
            backup = await client.exportBackup()
            const names = decodeBackup(backup).map(entry => decodeCanonicalBackupName(entry.name)).filter(Boolean)
            expect(names.some((name: string) => name.startsWith('trash/backup-'))).toBe(false)
            expect(backup.length).toBeLessThan(baselineSize + 64 * 1024)
            expect(normalizeBackup(backup).normalized.characters).toEqual(original)
            expect(await readFile(document)).toEqual(contents)
        }
        // Recovery copies remain on disk; the export must not delete them.
        const recovery = (await readdir(path.join(server.cwd, 'save/trash'))).filter(name => name.startsWith('backup-'))
        expect(recovery).toHaveLength(3)
        for (const name of recovery) {
            expect(await readFile(path.join(server.cwd, 'save/trash', name, 'risubard/wiki/notes/story.md'))).toEqual(contents)
        }
    })
})
