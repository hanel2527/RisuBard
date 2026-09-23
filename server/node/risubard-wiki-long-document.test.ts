import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { test, expect, vi } from 'vitest'
import { parseCanonicalBatch } from './risubard-memory-writer'
import { parseCanonicalSectionPatchMarkdown, applyCanonicalSectionPatches } from './risubard-markdown-section-patch'
import { createMarkdownNarrativeWiki } from './risubard-markdown-wiki'

const content = 'Established fact. '.repeat(1000).trim()

test.each([
    ['wiki/save', 'saveMarkdownWikiTurn'],
    ['wiki/document/save', 'saveCanonicalWikiDocument'],
    ['wiki/document/manual-save', 'saveManualWikiDocument'],
])('accepts a long document through %s', async (path, method) => {
    const { registerRisuBardMemoryRoutes } = createRequire(import.meta.url)('./risubard-memory-routes.cjs')
    const routes = new Map()
    const save = vi.fn(async () => ({ id: 'document' }))
    registerRisuBardMemoryRoutes({ post: (path: string, handler: unknown) => routes.set(path, handler) }, {
        auth: async () => true, service: { [method]: save },
    })
    const body = {
        characterId: 'character', chatId: 'chat', markdown: `## Alice\n\n${content}`,
        ...(path !== 'wiki/save' ? { type: 'character', title: 'Alice' } : {}),
        ...(path !== 'wiki/document/manual-save' ? { sourceMessageIds: ['turn-1'] } : {}),
    }
    const response = { status: vi.fn().mockReturnThis(), send: vi.fn() }
    await routes.get(`/api/risubard/memory/${path}`)({ body }, response, vi.fn())
    expect(response.status).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledWith(body)
})

test('preserves canonical section JSON beyond 12000 characters', () => {
    const sections = [{ heading: 'Current State', operation: 'upsert', content }]
    expect(parseCanonicalBatch(JSON.stringify({ documents: [{ candidateIndex: 0, sections }] }), 1)
        .documents[0].sections).toEqual(sections)
})

test('preserves Markdown section patches beyond 12000 characters', () => {
    const patches = parseCanonicalSectionPatchMarkdown(`### Current State\n\n${content}`)
    expect(applyCanonicalSectionPatches({ title: 'Alice', patches }))
        .toBe(`## Alice\n\n### Current State\n\n${content}`)
})

test('creates and updates long canonical documents without truncation', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'risubard-long-wiki-'))
    try {
        const wiki = createMarkdownNarrativeWiki(root)
        const input = { characterId: 'character', chatId: 'chat', sourceMessageIds: ['turn-1'], type: 'character' as const, title: 'Alice' }
        const markdown = `## Alice\n\n### Current State\n\n${content}`
        const created = await wiki.saveCanonicalDocument({ ...input, markdown })
        expect(created.content).toBe(markdown)
        const updated = await wiki.saveCanonicalDocument({ ...input, documentId: created.id, markdown: markdown + '\nNew state.' })
        expect(updated.content).toBe(markdown + '\nNew state.')
    } finally {
        await fs.rm(root, { recursive: true, force: true })
    }
})
