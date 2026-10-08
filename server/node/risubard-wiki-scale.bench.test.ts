import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { createMarkdownNarrativeWiki } from './risubard-markdown-wiki'
import {
    buildScaleFixture,
    scaleCanonicalCount,
    scaleCanonicalFolders,
    scaleCanonicalTitles,
    scaleCharacterId as characterId,
    scaleChatId as chatId,
    scaleParagraphs as paragraphs,
    scalePlaces,
    scaleSizes,
} from './risubard-wiki-scale.fixture'

// Long-chat scale benchmark (server side). Opt-in: pnpm bench:wiki-scale
// Sizes override: RISUBARD_SCALE_TURNS=300,1000,3000
const enabled = process.env.RISUBARD_SCALE_BENCH === '1'
    || process.env.npm_lifecycle_event === 'bench:wiki-scale'
const require = createRequire(import.meta.url)
const roots: string[] = []

afterAll(async () => {
    await Promise.all(roots.splice(0).map((root) =>
        fs.rm(root, { recursive: true, force: true })))
})

async function timed<T>(operation: () => Promise<T>): Promise<{ ms: number; value: T }> {
    const started = performance.now()
    const value = await operation()
    return { ms: Math.round((performance.now() - started) * 10) / 10, value }
}

const median = (values: number[]) =>
    [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]

describe.skipIf(!enabled)('BardWiki long-chat scale benchmark (server)', () => {
    test.each(scaleSizes())('%i turns', async (turns) => {
        const root = await fs.mkdtemp(join(tmpdir(), `risubard-scale-${turns}-`))
        roots.push(root)
        const fixture = await timed(() => buildScaleFixture(root, turns))
        const canonicalCount = scaleCanonicalCount(turns)
        const canonicalTitles = scaleCanonicalTitles(turns)
        const wiki = createMarkdownNarrativeWiki(root)

        const coldView = await timed(() => wiki.loadView(characterId, chatId))
        const warmViews: number[] = []
        for (let index = 0; index < 3; index++) {
            warmViews.push((await timed(() => wiki.loadView(characterId, chatId))).ms)
        }
        const serialized = await timed(async () => JSON.stringify(coldView.value))
        expect(coldView.value.documents).toHaveLength(turns + canonicalCount)
        const catalogs: number[] = []
        let catalogJson = ''
        for (let index = 0; index < 3; index++) {
            const catalog = await timed(() => wiki.loadCatalog(characterId, chatId))
            catalogs.push(catalog.ms)
            catalogJson = JSON.stringify(catalog.value)
        }

        const query = `${canonicalTitles[3]}가 ${scalePlaces[2]}에서 무엇을 숨겼지?`
        const inquireFirst = await timed(() => wiki.inquire({ characterId, chatId, currentInput: query }))

        const appendTurn = await timed(() => wiki.saveConfirmedTurn({
            characterId, chatId, sourceMessageIds: [`user-${turns}`, `assistant-${turns}`],
            markdown: `## 새 사건\n\n### 이야기 요약\n\n${paragraphs(turns + 1, 3, 2)}`,
        }))
        const inquireAfterWrite = await timed(() => wiki.inquire({ characterId, chatId, currentInput: query }))
        const inquireCached = await timed(() => wiki.inquire({ characterId, chatId, currentInput: query }))

        const canonicalUpdates: number[] = []
        for (let index = 0; index < 3; index++) {
            const [, type] = scaleCanonicalFolders[index % scaleCanonicalFolders.length]
            canonicalUpdates.push((await timed(() => wiki.saveCanonicalDocument({
                characterId, chatId, documentId: `${type}.bench-${index}`, type,
                title: canonicalTitles[index], sourceMessageIds: [`assistant-${turns}`],
                markdown: `## ${canonicalTitles[index]}\n\n### 현재 상태\n\n${paragraphs(30_000 + index, 4, 3)}`,
            }))).ms)
        }

        // Tab opened right after a turn: the view waits behind the turn's writes.
        const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
        const runtime = createRuntimeMemoryService(root)
        await runtime.loadView(characterId, chatId)
        const queuedStart = performance.now()
        const writesDone = Promise.all([
            runtime.saveMarkdownWikiTurn({
                characterId, chatId, sourceMessageIds: [`user-${turns + 1}`, `assistant-${turns + 1}`],
                markdown: `## 다음 사건\n\n### 이야기 요약\n\n${paragraphs(turns + 2, 3, 2)}`,
            }),
            ...[0, 1, 2].map((index) => {
                const [, type] = scaleCanonicalFolders[index % scaleCanonicalFolders.length]
                return runtime.saveCanonicalWikiDocument({
                    characterId, chatId, documentId: `${type}.bench-${index}`, type,
                    title: canonicalTitles[index], sourceMessageIds: [`assistant-${turns + 1}`],
                    markdown: `## ${canonicalTitles[index]}\n\n### 현재 상태\n\n${paragraphs(40_000 + index, 4, 3)}`,
                })
            }),
        ])
        const queuedView = await runtime.loadView(characterId, chatId)
        const queuedViewMs = Math.round(performance.now() - queuedStart)
        await writesDone
        expect(queuedView.documents.length).toBeGreaterThan(turns)

        const autosaveStart = performance.now()
        const autosaveDone = runtime.createMemorySave({
            characterId, sourceChatId: chatId, saveId: `bench-save-${turns}`,
            sourceChatName: 'bench', turnCount: turns,
            chatBytes: Buffer.alloc(turns * 2 * 1_500, 97),
        }).then(() => Math.round(performance.now() - autosaveStart))
        const viewDuringAutosave = await timed(() => runtime.loadView(characterId, chatId))
        const autosaveMs = await autosaveDone
        // The usual autosave: one more turn, then overwrite the same slot.
        await runtime.saveMarkdownWikiTurn({
            characterId, chatId, sourceMessageIds: [`user-${turns + 2}`, `assistant-${turns + 2}`],
            markdown: `## 그 다음 사건\n\n### 이야기 요약\n\n${paragraphs(turns + 3, 3, 2)}`,
        })
        const autosaveAgain = await timed(() => runtime.createMemorySave({
            characterId, sourceChatId: chatId, saveId: `bench-save-${turns}`, overwrite: true,
            sourceChatName: 'bench', turnCount: turns + 2,
            chatBytes: Buffer.alloc(turns * 2 * 1_500, 98),
        }))

        console.info('[BardWiki scale benchmark: server]', JSON.stringify({
            turns,
            documents: turns + canonicalCount,
            fixtureMs: fixture.ms,
            viewColdMs: coldView.ms,
            viewWarmMedianMs: median(warmViews),
            viewJsonKB: Math.round(Buffer.byteLength(serialized.value) / 1024),
            viewStringifyMs: serialized.ms,
            catalogWarmMedianMs: median(catalogs),
            catalogJsonKB: Math.round(Buffer.byteLength(catalogJson) / 1024),
            inquireFirstMs: inquireFirst.ms,
            appendTurnMs: appendTurn.ms,
            inquireAfterWriteMs: inquireAfterWrite.ms,
            inquireCachedMs: inquireCached.ms,
            canonicalUpdateMedianMs: median(canonicalUpdates),
            queuedViewAfterTurnMs: queuedViewMs,
            viewDuringAutosaveMs: viewDuringAutosave.ms,
            autosaveFirstMs: autosaveMs,
            autosaveNextMs: autosaveAgain.ms,
        }))
    }, 600_000)
})
