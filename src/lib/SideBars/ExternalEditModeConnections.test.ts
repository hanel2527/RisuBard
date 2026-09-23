import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('external file editing requires no sidebar mode button', () => {
    const sidebar = readFileSync(resolve(process.cwd(), 'src/lib/SideBars/Sidebar.svelte'), 'utf8')
    expect(sidebar).not.toContain('ExternalEditModeButton')
})
