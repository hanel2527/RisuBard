import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('BardWiki chat memory boundary', () => {
    it('does not dispatch the legacy summarizer from ordinary response generation', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/ts/process/index.svelte.ts'), 'utf8'
        )

        expect(source).not.toMatch(/\bhypaMemoryV3\s*\(/)
        expect(source).not.toContain('currentChat.hypaV3Data =')
        expect(source).toContain('selectNarrativeWorkingMessages(')
        expect(source).toContain('while(currentTokens > maxContextTokens)')
    })
})
