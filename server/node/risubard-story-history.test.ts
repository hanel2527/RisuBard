import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createStoryHistoryService, visitRetainedStoryContent } from './risubard-story-history'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import { putSaveBlob, releaseStorePages } from './risubard-memory-save-store'
import type { StoryChatDelta, StoryHistoryState } from '../../src/ts/risubard/storyHistoryTypes'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
const identity = { characterId: 'hero', chatId: 'story' }
const message = (id: string, data = id) => ({ chatId: id, role: 'char', data })

async function fixture(currentChat: Record<string, unknown> = { id: identity.chatId, message: [], scriptstate: { turn: 0 } }) {
    const root = await fs.mkdtemp(join(tmpdir(), 'story-history-'))
    roots.push(root)
    const directory = resolveMemoryWorkspace(root, identity.characterId, identity.chatId).directory
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(join(directory, 'wiki.md'), 'original wiki')
    const service = createStoryHistoryService(root)
    const state = await service.importLegacy({ ...identity, operationId: 'migration', imports: [],
        currentChat })
    return { root, directory, service, state, store: join(dirname(dirname(directory)), 'save-store') }
}
function delta(state: StoryHistoryState, ids: string[], changed: Array<Record<string, unknown>>, turn: number): StoryChatDelta {
    return { baseSnapshotId: state.workingSnapshotId, order: ids,
        messages: changed.map(value => ({ id: value.chatId as string, value })),
        state: { id: identity.chatId, scriptstate: { turn } } }
}

describe('durable story history', () => {
    test('requires explicit migration and rejects stale, incomplete, or duplicate deltas', async () => {
        const { root, service, state } = await fixture()
        const legacy = { ...identity, chatId: 'untouched' }
        expect((await service.status(legacy)).mode).toBe('legacy')
        await expect(service.capture({ ...legacy, operationId: 'not-migrated', kind: 'working',
            delta: { baseSnapshotId: null, order: [], messages: [], state: {} } })).rejects.toThrow('explicit migration')
        await expect(service.capture({ ...identity, operationId: 'missing', kind: 'working',
            delta: delta(state, ['a'], [], 1) })).rejects.toThrow('omitted')
        await expect(service.capture({ ...identity, operationId: 'duplicate', kind: 'working',
            delta: delta(state, ['a', 'a'], [message('a')], 1) })).rejects.toThrow('Duplicate')
        const next = await service.capture({ ...identity, operationId: 'a', kind: 'working', delta: delta(state, ['a'], [message('a')], 1) })
        await expect(service.capture({ ...identity, operationId: 'stale', kind: 'working', delta: delta(state, ['a'], [], 1) })).rejects.toThrow('base conflict')
        expect((await createStoryHistoryService(root).status(identity)).headId).toBe(next.headId)
    })

    test('delayed confirmation restores target variables and preserves later working chat across another capture', async () => {
        const { root, service, state, directory } = await fixture()
        const first = await service.capture({ ...identity, operationId: 'capture-a', kind: 'working',
            delta: delta(state, ['a'], [message('a')], 1) })
        const second = await service.capture({ ...identity, operationId: 'capture-b', kind: 'working',
            delta: delta(first, ['a', 'b'], [message('b')], 2) })
        const pending = await service.beginWiki({ ...identity, operationId: 'wiki-a', targetMessageId: 'a', sourceMessageIds: ['a'] })
        expect(pending.pendingWiki?.sourceBackupId).toBe(first.headId)
        await fs.writeFile(join(directory, 'wiki.md'), 'wiki through a')
        const committed = await service.finishWiki({ ...identity, operationId: 'wiki-a', outcome: 'applied' })
        expect(committed.workingSnapshotId).toBe(second.workingSnapshotId)
        const turn = await service.preview({ ...identity, backupId: committed.headId! })
        expect(turn.chat.scriptstate).toEqual({ turn: 1 })
        expect(turn.chat.message).toEqual([message('a')])
        const resumed = createStoryHistoryService(root)
        const third = await resumed.capture({ ...identity, operationId: 'capture-c', kind: 'working',
            delta: delta(committed, ['a', 'b', 'c'], [message('c')], 3) })
        expect((await resumed.preview({ ...identity, backupId: third.headId! })).chat.message).toEqual([message('a'), message('b'), message('c')])
        expect(third.bindings.a).toBe(committed.wikiCommitId)
    })

    test('confirms the last imported response after later turns without losing its saved variables', async () => {
        const { service, state } = await fixture({
            id: identity.chatId, message: [message('a')], scriptstate: { turn: 1 },
        })
        const user = { chatId: 'u2', role: 'user', data: 'Continue' }
        const nextInput = await service.capture({ ...identity, operationId: 'input-b', kind: 'working',
            delta: delta(state, ['a', 'u2'], [user], 1) })
        const later = await service.capture({ ...identity, operationId: 'capture-b', kind: 'working',
            delta: delta(nextInput, ['a', 'u2', 'b'], [message('b')], 2) })
        const pending = await service.beginWiki({ ...identity, operationId: 'wiki-a',
            targetMessageId: 'a', sourceMessageIds: ['a'] })
        expect(pending.pendingWiki?.sourceBackupId).toBe(state.headId)
        const committed = await service.finishWiki({ ...identity, operationId: 'wiki-a', outcome: 'unchanged' })
        expect(committed.bindings.a).toBe(committed.wikiCommitId)
        expect(committed.workingSnapshotId).toBe(later.workingSnapshotId)
        const preview = await service.preview({ ...identity, backupId: committed.headId! })
        expect(preview.chat.message).toEqual([message('a')])
        expect(preview.chat.scriptstate).toEqual({ turn: 1 })
        expect((await service.beginWiki({ ...identity, operationId: 'wiki-b',
            targetMessageId: 'b', sourceMessageIds: ['u2', 'b'] })).pendingWiki?.sourceBackupId).toBe(later.headId)
    })

    test('does not invent a historical turn boundary inside an imported chat', async () => {
        const { service, state } = await fixture({
            id: identity.chatId, message: [message('a'), message('b')], scriptstate: { turn: 2 },
        })
        await expect(service.beginWiki({ ...identity, operationId: 'wiki-a',
            targetMessageId: 'a', sourceMessageIds: ['a'] })).rejects.toThrow('Completed target-turn capture not found')
        await expect(service.beginWiki({ ...identity, operationId: 'wiki-a-explicit', sourceBackupId: state.headId!,
            targetMessageId: 'a', sourceMessageIds: ['a'] })).rejects.toThrow('Completed target-turn capture not found')
        expect((await service.status(identity)).pendingWiki).toBeNull()
    })

    test('editing one message preserves future messages, wiki and bindings, and immutable prior blobs', async () => {
        const { service, state, store } = await fixture()
        const a = await service.capture({ ...identity, operationId: 'a', kind: 'working', delta: delta(state, ['a'], [message('a')], 1) })
        await service.beginWiki({ ...identity, operationId: 'wiki', targetMessageId: 'a', sourceMessageIds: ['a'] })
        const bound = await service.finishWiki({ ...identity, operationId: 'wiki', outcome: 'unchanged' })
        const future = await service.capture({ ...identity, operationId: 'b', kind: 'working', delta: delta(bound, ['a', 'b'], [message('b')], 2) })
        const beforeSnapshot = JSON.parse(await fs.readFile(join(store, future.workingSnapshotId!.slice(0, 2), future.workingSnapshotId!), 'utf8'))
        const edited = await service.capture({ ...identity, operationId: 'edit', kind: 'chat-edit',
            delta: delta(future, ['a', 'b'], [message('a', 'edited')], 2) })
        const afterSnapshot = JSON.parse(await fs.readFile(join(store, edited.workingSnapshotId!.slice(0, 2), edited.workingSnapshotId!), 'utf8'))
        expect(afterSnapshot.messages[1].hash).toBe(beforeSnapshot.messages[1].hash)
        expect(afterSnapshot.stateHash).toBe(beforeSnapshot.stateHash)
        expect(afterSnapshot.messages[0].hash).not.toBe(beforeSnapshot.messages[0].hash)
        expect(edited.bindings).toEqual(future.bindings)
        expect(edited.wikiCommitId).toBe(future.wikiCommitId)
        expect((await service.preview({ ...identity, backupId: a.headId! })).chat.message).toEqual([message('a')])
        expect((await service.preview({ ...identity, backupId: edited.headId! })).chat.message).toEqual([message('a', 'edited'), message('b')])
    })

    test('manual wiki commit rebinds only selected wiki anchor, not a pending latest turn', async () => {
        const { service, state, directory } = await fixture()
        const a = await service.capture({ ...identity, operationId: 'a', kind: 'working', delta: delta(state, ['a'], [message('a')], 1) })
        await service.beginWiki({ ...identity, operationId: 'wa', targetMessageId: 'a', sourceMessageIds: ['a'] })
        const boundA = await service.finishWiki({ ...identity, operationId: 'wa', outcome: 'unchanged' })
        const b = await service.capture({ ...identity, operationId: 'b', kind: 'working', delta: delta(boundA, ['a', 'b'], [message('b')], 2) })
        await service.beginWiki({ ...identity, operationId: 'wb', targetMessageId: 'b', sourceMessageIds: ['a', 'b'] })
        const boundB = await service.finishWiki({ ...identity, operationId: 'wb', outcome: 'unchanged' })
        await service.capture({ ...identity, operationId: 'c', kind: 'working', delta: delta(boundB, ['a', 'b', 'c'], [message('c')], 3) })
        await fs.writeFile(join(directory, 'wiki.md'), 'manual wiki')
        const manual = await service.commitManualWiki({ ...identity, operationId: 'manual' })
        expect(manual.bindings.a).toBe(boundA.bindings.a)
        expect(manual.bindings.b).toBe(manual.wikiCommitId)
        expect(manual.bindings.c).toBeUndefined()
        const restored = await service.preview({ ...identity, backupId: manual.headId! })
        expect(restored.chat.message).toEqual([message('a'), message('b'), message('c')])
        expect(restored.chat.scriptstate).toEqual({ turn: 3 })
        expect(restored.documents?.find(file => file.path === 'wiki.md')?.content).toBe('manual wiki')
        expect(a.backups.length).toBeLessThan(b.backups.length)
    })

    test('failure recovers partial wiki, gates writers, freezes edited source and survives retry/kept', async () => {
        const { root, service, state, directory } = await fixture()
        const a = await service.capture({ ...identity, operationId: 'a', kind: 'working', delta: delta(state, ['a'], [message('a')], 1) })
        const b = await service.capture({ ...identity, operationId: 'b', kind: 'working', delta: delta(a, ['a', 'b'], [message('b')], 2) })
        await service.capture({ ...identity, operationId: 'edit', kind: 'chat-edit', delta: delta(b, ['a', 'b'], [message('a', 'chosen revision')], 2) })
        const started = await service.beginWiki({ ...identity, operationId: 'wiki', targetMessageId: 'a', sourceMessageIds: ['a'] })
        await fs.writeFile(join(directory, 'wiki.md'), 'partial failed wiki')
        const failed = await service.finishWiki({ ...identity, operationId: 'wiki', outcome: 'failed', error: 'write failed' })
        expect(await fs.readFile(join(directory, 'wiki.md'), 'utf8')).toBe('original wiki')
        expect(failed.pendingWiki?.status).toBe('failed')
        expect(failed.bindings).toEqual({})
        await expect(service.assertWritable(identity)).rejects.toThrow('pending')
        const resumed = createStoryHistoryService(root)
        await resumed.beginWiki({ ...identity, operationId: 'wiki', targetMessageId: 'a', sourceMessageIds: ['a'] })
        const source = await resumed.preview({ ...identity, backupId: started.pendingWiki!.sourceBackupId, sourceOperationId: 'wiki' })
        expect(source.chat.message).toEqual([message('a', 'chosen revision')])
        expect(source.chat.scriptstate).toEqual({ turn: 1 })
        const kept = await resumed.finishWiki({ ...identity, operationId: 'wiki', outcome: 'kept' })
        expect(kept.pendingWiki).toBeNull()
        expect(kept.bindings.a).toBe(kept.wikiCommitId)
        expect((await resumed.finishWiki({ ...identity, operationId: 'wiki', outcome: 'kept' })).revision).toBe(kept.revision)
    })

    test('past checkout moves cursor without deleting future and first mutation branches', async () => {
        const { root, service, state, directory } = await fixture()
        const a = await service.capture({ ...identity, operationId: 'a', kind: 'working', delta: delta(state, ['a'], [message('a')], 1) })
        const b = await service.capture({ ...identity, operationId: 'b', kind: 'working', delta: delta(a, ['a', 'b'], [message('b')], 2) })
        await fs.writeFile(join(directory, 'wiki.md'), 'later wiki')
        const prepared = await service.prepareCheckout({ ...identity, backupId: a.headId! })
        expect((await createStoryHistoryService(root).listPendingCheckouts())).toEqual([identity])
        expect((await createStoryHistoryService(root).recoverCheckout(identity))?.chat).toEqual(prepared.chat)
        const loaded = await service.completeCheckout({ ...identity, forkToken: prepared.forkToken, action: 'finalize' })
        expect(await fs.readFile(join(directory, 'wiki.md'), 'utf8')).toBe('original wiki')
        expect(loaded.branches.find(branch => branch.id === b.branchId)?.tipId).toBe(b.headId)
        const fork = await service.capture({ ...identity, operationId: 'fork', kind: 'chat-edit', delta: delta(loaded, ['a'], [message('a', 'fork')], 1) })
        expect(fork.branchId).not.toBe(b.branchId)
        expect(fork.backups.find(backup => backup.id === fork.headId)?.parentId).toBe(a.headId)
        expect((await service.preview({ ...identity, backupId: b.headId! })).chat.message).toEqual([message('a'), message('b')])
    })

    test('legacy slot GC and asset collection retain active and deactivated history', async () => {
        const { root, service, state, store } = await fixture()
        const assetMessage = { ...message('a'), data: '{{image::retained.png}}', assets: ['assets/retained.png'] }
        const next = await service.capture({ ...identity, operationId: 'asset', kind: 'working', delta: delta(state, ['a'], [assetMessage], 1) })
        const snapshotBytes = await fs.readFile(join(store, next.workingSnapshotId!.slice(0, 2), next.workingSnapshotId!))
        const snapshot = JSON.parse(snapshotBytes.toString('utf8'))
        const unused = await putSaveBlob(fs, store, Buffer.from('unreferenced page'))
        const unusedPath = join(store, unused.slice(0, 2), unused)
        await fs.writeFile(`${unusedPath}.bak`, 'previous page')
        await fs.writeFile(`${unusedPath}.bak.sha256`, 'previous checksum')
        const candidates = [unused, next.workingSnapshotId!, snapshot.stateHash, snapshot.messages[0].hash]
        await releaseStorePages(fs, store, candidates, [])
        for (const suffix of ['', '.sha256', '.bak', '.bak.sha256']) {
            await expect(fs.readFile(`${unusedPath}${suffix}`)).rejects.toMatchObject({ code: 'ENOENT' })
        }
        await service.deactivate({ ...identity, operationId: 'rollback' })
        await releaseStorePages(fs, store, candidates.slice(1), [])
        const retained: Record<string, unknown>[] = []
        visitRetainedStoryContent(root, value => retained.push(value))
        expect(retained).toContainEqual(assetMessage)
        const bytes = await fs.readFile(join(store, snapshot.messages[0].hash.slice(0, 2), snapshot.messages[0].hash))
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(snapshot.messages[0].hash)
    })

    test('migration canonicalizes optional undefined fields and preserves arrays as JSON', async () => {
        const { root } = await fixture()
        const service = createStoryHistoryService(root)
        const other = { ...identity, chatId: 'optional' }
        const currentChat = { id: other.chatId, note: undefined, localLore: [undefined], message: [{ ...message('optional'), receipt: undefined }] }
        const imported = await service.importLegacy({ ...other, operationId: 'optional-migration', imports: [], currentChat })
        const restored = await service.preview({ ...other, backupId: imported.headId! })
        expect(restored.chat).toEqual({ id: other.chatId, localLore: [null], message: [message('optional')] })
    })

    test('target boundary retains trailing inactive rows and explicit virtual source provenance', async () => {
        const { service, state } = await fixture()
        const comment = { ...message('comment'), isComment: true }
        const disabled = { ...message('disabled'), disabled: true }
        const captured = await service.capture({ ...identity, operationId: 'target-with-notes', kind: 'working',
            delta: delta(state, ['a', 'comment', 'disabled'], [message('a'), comment, disabled], 1) })
        expect(captured.backups.find(value => value.id === captured.headId)?.latestMessageId).toBe('a')
        const pending = await service.beginWiki({ ...identity, operationId: 'virtual-source', targetMessageId: 'a',
            sourceMessageIds: ['character:first-message', 'a'] })
        expect(pending.pendingWiki?.sourceMessageIds).toEqual(['character:first-message', 'a'])
        const committed = await service.finishWiki({ ...identity, operationId: 'virtual-source', outcome: 'unchanged' })
        expect((await service.preview({ ...identity, backupId: committed.headId! })).chat.message)
            .toEqual([message('a'), comment, disabled])
    })

    test('concurrent expected revisions cannot overwrite each other across service instances', async () => {
        const { root, service, state } = await fixture()
        const other = createStoryHistoryService(root)
        const results = await Promise.allSettled([service, other].map((writer, index) =>
            writer.capture({ ...identity, expectedRevision: state.revision, operationId: `concurrent-${index}`,
                kind: 'working', delta: delta(state, ['a'], [message('a', `version-${index}`)], 1) })))
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
        expect((await service.status(identity)).backups).toHaveLength(state.backups.length + 1)
    })

    test('copy checkout shares immutable records but exports the destination chat identity', async () => {
        const { service, state } = await fixture()
        const captured = await service.capture({ ...identity, operationId: 'a', kind: 'working',
            delta: delta(state, ['a'], [message('a')], 1) })
        const prepared = await service.prepareCheckout({ ...identity, backupId: captured.headId!, asNewChat: true, destinationChatId: 'copied' })
        expect(prepared.chat.id).toBe('copied')
        await service.completeCheckout({ ...identity, destinationChatId: 'copied', forkToken: prepared.forkToken, action: 'finalize' })
        const exported = await service.exportHistory({ ...identity, chatId: 'copied' })
        expect(exported.currentChat.id).toBe('copied')
        expect(exported.backups.every(value => value.chat.id === 'copied')).toBe(true)
        expect((await service.status(identity)).headId).toBe(captured.headId)
    })
})
