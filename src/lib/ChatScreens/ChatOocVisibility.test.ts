import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { oocTurnIndices } from 'src/ts/risubard/oocTurns'

const chatsSource = readFileSync(resolve(process.cwd(), 'src/lib/ChatScreens/Chats.svelte'), 'utf8')

const transcript = [
    { role: 'user' as const, data: 'normal input', chatId: 'u1' },
    { role: 'char' as const, data: 'normal reply', chatId: 'a1' },
    { role: 'user' as const, data: 'OOC planning input', chatId: 'u2' },
    { role: 'char' as const, data: '<!-- OOC_turn --> OOC planning reply', chatId: 'a2' },
    { role: 'user' as const, data: 'normal input after OOC', chatId: 'u3' },
    { role: 'char' as const, data: 'normal reply after OOC', chatId: 'a3' },
]

describe('main chat OOC visibility contract', () => {
    test('the renderer derives hidden indices and skips them without renumbering visible messages', () => {
        expect(chatsSource).toContain('oocTurnIndices')
        expect(chatsSource).toContain('oocTurnIndices(messages')
        expect(chatsSource).toMatch(/if\s*\(hiddenOocIndices\.has\(i\)\)\s*continue/)
        expect(chatsSource).toContain('idx: i')
    })

    test('the page reports when every message in its absolute range is hidden', () => {
        expect(chatsSource).toContain('data-ooc-page-hidden')
        expect(chatsSource).toMatch(/pageStart[\s\S]*pageEnd[\s\S]*hiddenOocIndices/)
    })

    test('the existing helper identifies both the marked assistant and its paired user', () => {
        const hidden = oocTurnIndices(transcript)
        expect([...hidden].sort((a, b) => a - b)).toEqual([2, 3])

        const visible = transcript
            .map((message, index) => ({ message, index }))
            .filter(({ index }) => !hidden.has(index))
        expect(visible.map(({ message, index }) => ({ idx: index, data: message.data }))).toEqual([
            { idx: 0, data: 'normal input' },
            { idx: 1, data: 'normal reply' },
            { idx: 4, data: 'normal input after OOC' },
            { idx: 5, data: 'normal reply after OOC' },
        ])
    })

    test('turn hiding is reversible when the option is disabled', () => {
        const hidden = oocTurnIndices(transcript, true)
        const restored = oocTurnIndices(transcript, false)
        expect(hidden.size).toBe(2)
        expect(restored.size).toBe(0)
        expect(transcript).toHaveLength(6)
    })
})
