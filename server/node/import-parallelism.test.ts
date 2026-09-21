import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('./server.cjs', import.meta.url), 'utf8')
const restore = readFileSync(new URL('./backup-restore-transaction.cjs', import.meta.url), 'utf8')

describe('data import parallelism connections', () => {
    it('publishes backup and save-folder objects through asynchronous atomic KV replacement', () => {
        expect(server).toContain('await preparePrefixReplacementFromFilesAsync(stagedKvEntries')
        expect(server).toContain('await publishBackupRestore({')
        expect(server).toContain('await kvReplacePrefixesFromFilesAsync(stagedKvEntries')
        expect(server).toContain('await kvReplaceAllAsync(entries)')
    })

    it('keeps backup entries and canonical transaction inputs disk-backed', () => {
        expect(server).toContain('stageBackupEntries(dataSource')
        expect(restore).toContain('sourcePath: child')
        expect(server).not.toContain('stagedKvEntries.push({ key: storageKey, value: Buffer.from(storageValue) })')
    })

    it('decompresses uploaded save-folder ZIPs through the worker-thread fflate API', () => {
        const route = server.slice(
            server.indexOf("app.post('/api/migrate/save-folder/upload'"),
            server.indexOf("app.post('/api/migrate/save-folder/cleanup/scan'"),
        )
        expect(route).toContain('fflate.unzip(')
        expect(route).not.toContain('unzipSync')
    })
})
