import { test, expect, vi } from 'vitest'
import { requestMarkdownWikiDraft, saveCanonicalWikiDocument } from './markdownWikiWriter'
import { saveManualWikiDocument } from './memoryWiki'

const markdown = '## Alice\n\n' + 'Established fact. '.repeat(1000).trim()

test('retains generated wiki drafts beyond 12000 characters', async () => {
    await expect(requestMarkdownWikiDraft({
        type: 'character', title: 'Alice', instruction: 'Update established facts.',
        evidence: [{ id: 'event', type: 'event', title: 'Event', content: 'Facts', sourceMessageIds: ['turn-1'] }],
        requestModel: async () => ({ type: 'success', result: markdown }),
    })).resolves.toBe(markdown)
})

test.each([saveCanonicalWikiDocument, saveManualWikiDocument])('submits a long wiki document intact', async (save) => {
    const fetchImpl = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body)).markdown).toBe(markdown)
        return new Response(JSON.stringify({
            id: 'character.alice', type: 'character', status: 'active', title: 'Alice',
            aliases: [], relativePath: 'characters/Alice.md', sourceMessageIds: ['turn-1'],
            updated: '2026-09-22T00:00:00Z', content: markdown, links: [],
            contextMode: 'auto', contentHash: 'hash', authoring: 'manual',
        }))
    })
    await expect(save({
        characterId: 'character', chatId: 'chat', type: 'character', title: 'Alice',
        sourceMessageIds: ['turn-1'], markdown, fetchImpl, createAuth: async () => 'token',
    })).resolves.toMatchObject({ content: markdown })
    expect(fetchImpl).toHaveBeenCalledOnce()
})
