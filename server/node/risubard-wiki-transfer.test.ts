import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, test } from 'vitest'
import { createMarkdownNarrativeWiki, resolveMarkdownWikiWorkspace } from './risubard-markdown-wiki'
import { inheritWikiWorkspace, importWikiWorkspace } from './risubard-wiki-transfer'
import { completeMemoryWorkspaceFork } from './risubard-memory-fork'
import { createWikiPackage } from '../../src/ts/risubard/wikiTransferPackage'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function setup() {
    const root = await fs.mkdtemp(join(tmpdir(), 'wiki-transfer-')); roots.push(root)
    return { root, wiki: createMarkdownNarrativeWiki(root), scope: { characterId: 'char', chatId: 'source' } }
}
test('inherits document identities, event links and arc checkpoint but separates original message sources', async () => {
    const { root, wiki, scope } = await setup()
    const event = await wiki.saveConfirmedTurn({ ...scope, sourceMessageIds: ['m1'], markdown: '## 사건\n\n숲에 갔다.' })
    const alice = await wiki.saveCanonicalDocument({ ...scope, type: 'character', title: '앨리스', sourceMessageIds: ['m1'], markdown: `## 앨리스\n\n[[${event.title}]]` })
    await wiki.saveManualDocument({ ...scope, type: 'other', title: '스토리 아크 플롯', markdown: `## 스토리 아크 플롯\n\n[[${event.title}]]\n\n<!-- risubard-story-arc-checkpoint: ${event.id} -->` })
    await fs.writeFile(join(resolveMemoryWorkspace(root, 'char', 'source').directory, 'legacy-source.json'), 'old transcript')
    const receipt = await inheritWikiWorkspace({ userDataDirectory: root, characterId: 'char', sourceChatId: 'source', destinationChatId: 'new' })
    await expect(fs.access(join(resolveMemoryWorkspace(root, 'char', 'new').directory, 'legacy-source.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const copy = await wiki.loadView('char', 'new')
    expect(copy.documents.map(doc => doc.id).sort()).toEqual((await wiki.loadView('char', 'source')).documents.map(doc => doc.id).sort())
    expect(copy.documents.find(doc => doc.id === alice.id)?.content).toBe(alice.content)
    expect(copy.documents.find(doc => doc.id === event.id)?.sourceMessageIds[0]).toMatch(/^inherited:/)
    expect(copy.documents.find(doc => doc.title === '스토리 아크 플롯')?.content).toContain(`checkpoint: ${event.id}`)
    expect((await wiki.loadView('char', 'source')).documents.find(doc => doc.id === event.id)?.sourceMessageIds).toEqual(['m1'])
    await wiki.retractEventsBySourceMessages({ characterId: 'char', chatId: 'new', sourceMessageIds: ['m1'] })
    expect((await wiki.loadView('char', 'new')).documents.some(doc => doc.id === event.id)).toBe(true)
    const updated = await wiki.saveCanonicalDocument({ characterId: 'char', chatId: 'new', documentId: alice.id, type: 'character', title: '앨리스', sourceMessageIds: ['new-message'], markdown: '## 앨리스\n\n새 챗에서 성장했다.' })
    expect(updated.id).toBe(alice.id)
    expect(updated.sourceMessageIds).toContain('new-message')
    expect(updated.sourceMessageIds.some(id => id.startsWith('inherited:'))).toBe(true)
    expect((await wiki.loadView('char', 'new')).documents.filter(doc => doc.title === '앨리스')).toHaveLength(1)
    await completeMemoryWorkspaceFork({ userDataDirectory: root, characterId: 'char', destinationChatId: 'new', forkToken: receipt.forkToken, action: 'finalize' })
})
test('imports canon into an existing wiki without importing source IDs or changing existing events', async () => {
    const { root, wiki, scope } = await setup()
    const event = await wiki.saveConfirmedTurn({ ...scope, sourceMessageIds: ['m1'], markdown: '## 사건\n\n기존 사건.' })
    const pack = createWikiPackage([{ id: 'alice', type: 'character', title: '앨리스', aliases: ['Alice'], content: '## 앨리스\n\n[[숲]]', contextMode: 'never', retrievalMetadata: { keywords: ['마녀'] } }, { id: 'forest', type: 'location', title: '숲', content: '## 숲\n\n[[앨리스]]', contextMode: 'auto' }], ['alice', 'forest'])
    await expect(importWikiWorkspace({ userDataDirectory: root, ...scope, package: pack })).resolves.toEqual({ imported: 2 })
    const view = await wiki.loadView('char', 'source')
    expect(view.documents.find(doc => doc.id === event.id)?.contentHash).toBe(event.contentHash)
    expect(view.documents.find(doc => doc.title === '앨리스')).toMatchObject({ aliases: ['Alice'], sourceMessageIds: [], contextMode: 'never', retrievalMetadata: { keywords: ['마녀'] } })
    expect(view.health.danglingLinks).toEqual([])
    await expect(importWikiWorkspace({ userDataDirectory: root, ...scope, package: pack })).rejects.toThrow('충돌')
    expect((await wiki.loadView('char', 'source')).documents).toHaveLength(3)
})
test('invalid second document leaves the whole destination unchanged', async () => {
    const { root, wiki, scope } = await setup()
    await wiki.saveManualDocument({ ...scope, type: 'character', title: '기존', markdown: '## 기존\n\n보존' })
    const before = await wiki.loadView('char', 'source')
    const pack = createWikiPackage([{ id: 'alice', type: 'character', title: '앨리스', content: '## 앨리스\n\n내용', contextMode: 'auto' }], ['alice'])
    const bad = { ...pack, documents: [...pack.documents, { ...pack.documents[0], id: 'bad', title: '잘못', type: 'event' }] }
    await expect(importWikiWorkspace({ userDataDirectory: root, ...scope, package: bad })).rejects.toThrow()
    expect((await wiki.loadView('char', 'source')).documents).toEqual(before.documents)
})

test('retries finalize after publication instead of attempting an incompatible discard', async () => {
    const { root, wiki, scope } = await setup()
    const pack = createWikiPackage([{ id: 'alice', type: 'character', title: '앨리스', content: '## 앨리스\n\n내용' }], ['alice'])
    let calls = 0
    await expect(importWikiWorkspace({ userDataDirectory: root, ...scope, package: pack }, {
        completeFork: async (input) => {
            expect(input.action).toBe('finalize')
            const result = await completeMemoryWorkspaceFork(input)
            if (++calls === 1) throw new Error('response lost after publish')
            return result
        },
    })).resolves.toEqual({ imported: 1 })
    expect(calls).toBe(2)
    expect((await wiki.loadView('char', 'source')).documents).toHaveLength(1)
})

test('preserves and blocks a pending recovery checkpoint', async () => {
    const { root, scope } = await setup()
    const recovery = resolveMarkdownWikiWorkspace(root, 'char', 'source').recoveryDirectory
    await fs.mkdir(recovery, { recursive: true })
    await fs.writeFile(join(recovery, 'checkpoint'), 'pending')
    const pack = createWikiPackage([{ id: 'alice', type: 'character', title: '앨리스', content: '## 앨리스\n\n내용' }], ['alice'])
    await expect(importWikiWorkspace({ userDataDirectory: root, ...scope, package: pack })).rejects.toThrow('복구')
    expect(await fs.readFile(join(recovery, 'checkpoint'), 'utf8')).toBe('pending')
})

test('runtime serializes competing imports and refreshes the active wiki catalog', async () => {
    const { root } = await setup()
    const require = createRequire(import.meta.url)
    const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
    const service = createRuntimeMemoryService(root)
    await service.loadView('char', 'source')
    const pack = createWikiPackage([{ id: 'alice', type: 'character', title: '앨리스', content: '## 앨리스\n\n내용' }], ['alice'])
    const input = { characterId: 'char', chatId: 'source', package: pack }
    const results = await Promise.allSettled([service.importWiki(input), service.importWiki(input)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await service.loadView('char', 'source')).documents).toHaveLength(1)
    const fork = await service.inheritWiki({ characterId: 'char', sourceChatId: 'source', destinationChatId: 'new' })
    expect(fork.destinationChatId).toBe('new')
    expect((await service.loadView('char', 'new')).documents).toHaveLength(1)
})
