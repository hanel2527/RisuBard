import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const hasBash = spawnSync(bash, ['--version']).status === 0

test.skipIf(!hasBash)('source update preserves user root entries and reserved data while replacing shipped files', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'risubard-source-update-'))
    const install = join(fixture, 'install')
    const release = join(fixture, 'release')
    const scratch = join(fixture, 'scratch')
    const put = (root: string, name: string, text: string) => {
        const path = join(root, name)
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, text)
    }
    try {
        mkdirSync(scratch)
        for (const name of ['Archive Center/notes.txt', '.custom/settings', 'personal.txt', 'save/data', 'backups/data', 'config.json', '.env', '.npmrc']) {
            put(install, name, 'user content')
        }
        put(install, 'server/obsolete.cjs', 'obsolete')
        put(install, 'package.json', 'old')
        for (const name of ['save/data', 'backups/data', 'config.json', '.env', '.npmrc']) put(release, name, 'package default')
        put(release, 'server/current.cjs', 'new')
        put(release, 'package.json', 'new')
        put(release, '.new-hidden', 'new')
        const source = readFileSync(fileURLToPath(new URL('../../update.sh', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
        const section = source.slice(source.indexOf('info "Updating files..."'), source.indexOf('# ── Rebuild'))
        const result = spawnSync(bash, ['-c', 'set -euo pipefail\nSCRIPT_DIR="$1"\nEXTRACTED_DIR="$2"\nTMP_DIR="$3"\ninfo() { :; }\n' + section, '--', install.replace(/\\/g, '/'), release.replace(/\\/g, '/'), scratch.replace(/\\/g, '/')], { encoding: 'utf8' })
        expect(result.status, result.stderr).toBe(0)
        for (const name of ['Archive Center/notes.txt', '.custom/settings', 'personal.txt', 'save/data', 'backups/data', 'config.json', '.env', '.npmrc']) {
            expect(existsSync(join(install, name)), name).toBe(true)
            expect(readFileSync(join(install, name), 'utf8')).toBe('user content')
        }
        for (const name of ['server/current.cjs', 'package.json', '.new-hidden']) expect(readFileSync(join(install, name), 'utf8')).toBe('new')
        expect(existsSync(join(install, 'server/obsolete.cjs'))).toBe(false)
    } finally {
        if (dirname(fixture) !== tmpdir() || !basename(fixture).startsWith('risubard-source-update-')) {
            throw new Error('Unsafe fixture cleanup')
        }
        rmSync(fixture, { recursive: true, force: true })
    }
})
