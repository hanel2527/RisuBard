import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('sendChat completion notification', () => {
    it('does not request permission outside the settings user gesture', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/ts/process/index.svelte.ts'),
            'utf8'
        )
        const start = source.indexOf('if(requestSettings.notification')
        const end = source.indexOf('\n    if(req.special)', start)
        expect(start).toBeGreaterThanOrEqual(0)
        expect(end).toBeGreaterThan(start)
        const block = source.slice(start, end)

        expect(block).not.toContain('Notification.requestPermission()')
        expect(block).toContain("Notification.permission === 'granted'")
    })
})
