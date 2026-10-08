// @vitest-environment happy-dom
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mount, tick, unmount } from 'svelte'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { createMarkdownNarrativeWiki } from '../../../server/node/risubard-markdown-wiki'
import {
    buildScaleFixture,
    buildScaleMessages,
    scaleCanonicalTitles,
    scaleCharacterId as characterId,
    scaleChatId as chatId,
    scalePlaces,
    scaleSizes,
} from '../../../server/node/risubard-wiki-scale.fixture'
import { findHistoricalSourceMatches } from './historicalSourceRecall'
import { loadNarrativeMemoryWiki } from './memoryWiki'
import { buildWikiFileTree } from './wikiFileTree'
import { chunkWikiDocument } from './wikiEmbeddingChunks'
import RisuBardWikiEditor from '../../lib/Others/RisuBardWikiEditor.svelte'

// Long-chat scale benchmark (client side). Opt-in: pnpm bench:wiki-scale
const enabled = process.env.RISUBARD_SCALE_BENCH === '1'
    || process.env.npm_lifecycle_event === 'bench:wiki-scale'
const roots: string[] = []

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: async () => 'token' },
    requestImmediateSave: async () => undefined,
}))
vi.mock('src/ts/stores.svelte', () => ({
    DBState: { db: { characters: [], risuBardWikiMarkdownPreview: undefined } },
}))
vi.mock('src/ts/alert', () => ({ alertConfirmMulti: async () => 0 }))

afterAll(async () => {
    await Promise.all(roots.splice(0).map((root) =>
        fs.rm(root, { recursive: true, force: true })))
})

function timedSync<T>(operation: () => T): { ms: number; value: T } {
    const started = performance.now()
    const value = operation()
    return { ms: Math.round((performance.now() - started) * 10) / 10, value }
}

async function timed<T>(operation: () => Promise<T>): Promise<{ ms: number; value: T }> {
    const started = performance.now()
    const value = await operation()
    return { ms: Math.round((performance.now() - started) * 10) / 10, value }
}

describe.skipIf(!enabled)('BardWiki long-chat scale benchmark (client)', () => {
    test.each(scaleSizes())('%i turns', async (turns) => {
        const root = await fs.mkdtemp(join(tmpdir(), `risubard-scale-client-${turns}-`))
        roots.push(root)
        await buildScaleFixture(root, turns)
        const view = await createMarkdownNarrativeWiki(root).loadView(characterId, chatId)
        const json = JSON.stringify(view)
        const messages = buildScaleMessages(turns)

        const parsed = await timed(() => loadNarrativeMemoryWiki({
            characterId, chatId, createAuth: async () => 'token',
            fetchImpl: (async () => new Response(json)) as unknown as typeof fetch,
        }))
        const documents = (parsed.value as { documents: typeof view.documents }).documents
        expect(documents).toHaveLength(view.documents.length)

        const tree = timedSync(() => buildWikiFileTree(documents, messages))
        const recall = timedSync(() => findHistoricalSourceMatches({
            currentInput: `${scaleCanonicalTitles(turns)[3]}가 ${scalePlaces[2]}에서 무엇을 숨겼지?`,
            messages, maximumMatches: 8,
        }))
        const wikiChunks = documents.reduce((total, document) =>
            total + chunkWikiDocument(document).length, 0)
        const messageChunks = messages.reduce((total, message) => total + chunkWikiDocument({
            id: message.chatId, title: 'source', contentHash: '1', content: message.data,
        }).length, 0)

        const mounted = await timed(async () => {
            const component = mount(RisuBardWikiEditor, {
                target: document.body,
                props: { characterId, chatId, documents, messages },
            })
            await tick()
            return component
        })
        const renderedRows = document.body.querySelectorAll('button, [role="treeitem"]').length
        unmount(mounted.value)
        document.body.innerHTML = ''

        console.info('[BardWiki scale benchmark: client]', JSON.stringify({
            turns,
            documents: documents.length,
            messages: messages.length,
            viewParseValidateMs: parsed.ms,
            fileTreeMs: tree.ms,
            historicalRecallPerSendMs: recall.ms,
            editorMountMs: mounted.ms,
            editorButtons: renderedRows,
            embeddingChunks: wikiChunks + messageChunks,
            // Cold cache: one batched read per 64-chunk wiki page and 256-chunk history page.
            embeddingCacheRequestsCold: Math.ceil(wikiChunks / 64) + Math.ceil(messageChunks / 256),
        }))
    }, 600_000)
})
