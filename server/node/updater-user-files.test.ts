import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, expect, test } from 'vitest'

const roots: string[] = []
function write(root: string, name: string, contents: string) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
}
afterEach(() => {
    for (const root of roots.splice(0)) {
        if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('risubard-user-files-')) throw new Error('Unsafe fixture cleanup')
        fs.rmSync(root, { recursive: true, force: true })
    }
})

// Execute the actual replacement blocks, with download/process startup excluded.
// This exercises disk moves and rollback without running a live updater.
test.each(['standalone-windows', 'standalone-unix', 'server-unix'])('%s preserves user entries after successful cleanup and failed validation', async (mode) => {
    for (const fail of [false, true]) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-user-files-'))
        roots.push(root)
        const tmp = path.join(root, '.update-tmp')
        const source = path.join(tmp, 'extracted')
        write(root, 'package.json', 'old app')
        write(root, 'dist/index.html', 'old UI')
        write(root, '아치브 센터/nested/archive.bin', 'irreplaceable archive')
        write(root, 'personal.txt', 'personal notes')
        write(root, '.personal-config', 'hidden user file')
        write(root, '.env', 'private config')
        write(root, 'backups/archive.bin', 'user backup')
        write(source, 'package.json', 'new app')
        write(source, 'dist/index.html', 'new UI')
        write(source, 'new-app-file.txt', 'new file')
        write(source, '.env', 'package default must not overwrite')
        write(source, 'backups/archive.bin', 'package default must not overwrite')
        const restore = (backup: string) => {
            for (const entry of fs.readdirSync(backup)) {
                fs.rmSync(path.join(root, entry), { recursive: true, force: true })
                fs.renameSync(path.join(backup, entry), path.join(root, entry))
            }
        }
        const standalone = mode.startsWith('standalone')
        const text = fs.readFileSync(standalone ? 'scripts/updater.cjs' : 'server/node/server.cjs', 'utf8')
        const start = standalone ? text.indexOf('    const keep = new Set(') : text.indexOf('        // Keep set')
        const end = text.indexOf('// Phase 3:', start)
        expect(start).toBeGreaterThan(-1)
        expect(end).toBeGreaterThan(start)
        const run = vm.runInNewContext(`(async () => { ${text.slice(start, end)} })()`, {
            fs: standalone ? fs : fs.promises, path, ROOT: root, appDir: root,
            extractedRoot: source, sourceDir: source, tmpDir: tmp, updateTmp: tmp,
            isWin: mode === 'standalone-windows', skipBinReplacement: false,
            getCustomBackupKeepEntry: () => null, existsSync: fs.existsSync,
            restoreBackupIntoRoot: restore, restoreBackup: restore,
            moveAcrossVolumes: fs.promises.rename,
            error: (message: string) => { throw new Error(message) },
            log: () => {}, logger: { error: () => {} }, console: { log: () => {} },
            REQUIRED_ENTRIES: ['package.json', 'dist'], REQUIRED_DIST_FILES: ['index.html'],
            validatePackage: () => { if (fail) throw new Error('invalid installed package') },
        })
        if (fail) await expect(run).rejects.toThrow('previous version restored')
        else await run
        // Mirrors successful update.bat / Unix temp cleanup.
        fs.rmSync(tmp, { recursive: true, force: true })
        expect(fs.readFileSync(path.join(root, '아치브 센터/nested/archive.bin'), 'utf8')).toBe('irreplaceable archive')
        expect(fs.readFileSync(path.join(root, 'personal.txt'), 'utf8')).toBe('personal notes')
        expect(fs.readFileSync(path.join(root, '.personal-config'), 'utf8')).toBe('hidden user file')
        expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('private config')
        expect(fs.readFileSync(path.join(root, 'backups/archive.bin'), 'utf8')).toBe('user backup')
        expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(fail ? 'old app' : 'new app')
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe(fail ? 'old UI' : 'new UI')
    }
})
