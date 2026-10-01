import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Packr, Unpackr } from 'msgpackr'
import {
    chatBoundaryAnchor,
    computeWikiPrefixDigests,
} from '../../src/ts/risubard/wikiVcsContract'
import {
    createWikiVcsRepository,
    resolveWikiVcsRepository,
} from './risubard-wiki-vcs'
import { createWikiVersioning } from './risubard-wiki-versioning'

const roots: string[] = []

async function createRoot(): Promise<string> {
    const root = await fs.mkdtemp(join(tmpdir(), 'risubard-wiki-vcs-'))
    roots.push(root)
    return root
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
        fs.rm(root, { recursive: true, force: true })
    ))
})

const anchor = (chatId: string, boundaryMessageId: string | null = 'message-1') =>
    chatBoundaryAnchor(chatId, boundaryMessageId, [{
        messageId: boundaryMessageId ?? 'message-1',
        role: 'assistant',
        data: `content at ${boundaryMessageId}`,
    }])

async function writeWorkingTree(
    root: string,
    chatId: string,
    files: Record<string, string>
): Promise<void> {
    const workspace = resolveWikiVcsRepository(root, 'character', chatId)
    for (const [path, contents] of Object.entries(files)) {
        const target = join(workspace.workingTreeDirectory, ...path.split('/'))
        await fs.mkdir(join(target, '..'), { recursive: true })
        await fs.writeFile(target, contents)
    }
}

function failOneRename(destinationSuffix: string): {
    fileSystem: typeof fs
    didFail: () => boolean
} {
    let failed = false
    const fileSystem: typeof fs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'rename') {
                const rename = target.rename.bind(target)
                return async (
                    source: Parameters<typeof fs.rename>[0],
                    destination: Parameters<typeof fs.rename>[1]
                ) => {
                    if (!failed && String(destination).endsWith(destinationSuffix)) {
                        failed = true
                        throw Object.assign(new Error('EIO'), { code: 'EIO' })
                    }
                    return rename(source, destination)
                }
            }
            return Reflect.get(target, property, receiver)
        },
    })
    return { fileSystem, didFail: () => failed }
}

describe('wiki VCS repository', () => {
    test('round trips additions, edits, deletions and renames between branches', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'chat-1', {
            'characters/aria.md': 'Aria v1',
            'locations/keep.md': 'Keep v1',
        })
        const baseline = await repository.ensureBaseline({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: anchor('chat-1', null),
        })
        expect(baseline.created).toBe(true)

        const first = await repository.commit({
            characterId: 'character',
            chatId: 'chat-1',
            operationId: 'turn-1',
            expectedHead: baseline.commitId,
            kind: 'analysis',
            chatAnchor: anchor('chat-1'),
            changes: [
                { path: 'characters/aria.md', contents: 'Aria v2' },
                { path: 'items/sword.md', contents: 'Sword' },
            ],
        })
        const second = await repository.commit({
            characterId: 'character',
            chatId: 'chat-1',
            operationId: 'turn-2',
            expectedHead: first.commitId,
            kind: 'manual',
            chatAnchor: anchor('chat-1', 'message-2'),
            changes: [
                // Rename and delete are expressed as path-level changes.
                { path: 'items/sword.md', contents: null },
                { path: 'characters/aria-renamed.md', contents: 'Aria v2' },
                { path: 'characters/aria.md', contents: null },
            ],
        })

        const forked = await repository.fork({
            characterId: 'character',
            sourceChatId: 'chat-1',
            destinationChatId: 'chat-2',
            commitId: first.commitId,
        })
        expect(forked.commitId).toBe(first.commitId)

        // Replay: fork starts from the first commit, original continues.
        await repository.checkout({
            characterId: 'character',
            chatId: 'chat-1',
            commitId: baseline.commitId!,
            reason: 'truncate',
        })
        const restored = resolveWikiVcsRepository(root, 'character', 'chat-1')
        expect(await fs.readFile(
            join(restored.workingTreeDirectory, 'characters', 'aria.md'), 'utf8'
        )).toBe('Aria v1')
        await expect(fs.readFile(join(
            restored.workingTreeDirectory, 'items', 'sword.md'
        ), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

        // The truncated future survives as a recovery ref.
        const recovery = await repository.listRefs({
            characterId: 'character',
            chatId: 'chat-1',
            kind: 'recovery',
        })
        expect(recovery.map((ref) => ref.commitId)).toContain(second.commitId)
        const recoveryContent = await repository.readPathMap(
            'character', 'chat-1', recovery[0].commitId
        )
        expect(recoveryContent['characters/aria-renamed.md']).toBeTruthy()

        // Both branches share the blob written once by the first commit.
        const shared = await repository.readCommit(
            'character', 'chat-2', forked.commitId
        )
        expect(shared?.changes.map((change) => change.path)).toEqual([
            'characters/aria.md', 'items/sword.md',
        ])
    })

    test('recovers a checkout interrupted after its second file write', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'chat-1', {
            'characters/one.md': 'one-v1',
            'locations/two.md': 'two-v1',
        })
        const baseline = await repository.ensureBaseline({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: anchor('chat-1', null),
        })
        const published = await repository.publishChanges({
            characterId: 'character',
            chatId: 'chat-1',
            operationId: 'two-document-publish',
            kind: 'analysis',
            expectedHead: baseline.commitId,
            changes: [
                { path: 'characters/one.md', contents: 'one-v2' },
                { path: 'locations/two.md', contents: 'two-v2' },
            ],
        })
        const failure = failOneRename('/locations/two.md')
        const interrupted = createWikiVcsRepository(root, {
            fileSystem: failure.fileSystem,
        })
        await expect(interrupted.checkout({
            characterId: 'character',
            chatId: 'chat-1',
            commitId: baseline.commitId!,
        })).rejects.toMatchObject({ code: 'EIO' })
        expect(failure.didFail()).toBe(true)

        const restarted = createWikiVcsRepository(root)
        const recovered = await restarted.recoverOperations({
            characterId: 'character',
            chatId: 'chat-1',
        })
        expect(recovered.completed).toHaveLength(1)
        const workspace = resolveWikiVcsRepository(root, 'character', 'chat-1')
        expect(await fs.readFile(
            join(workspace.workingTreeDirectory, 'characters/one.md'), 'utf8'
        )).toBe('one-v1')
        expect(await fs.readFile(
            join(workspace.workingTreeDirectory, 'locations/two.md'), 'utf8'
        )).toBe('two-v1')
        const recoveryRefs = await restarted.listRefs({
            characterId: 'character',
            chatId: 'chat-1',
            kind: 'recovery',
        })
        expect(recoveryRefs.map((ref) => ref.commitId))
            .toContain(published.commitId)
    })

    test('recovery leaves external edits pending until the conflicted path is resolved', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'chat-1', {
            'characters/one.md': 'one-v1',
            'locations/two.md': 'two-v1',
        })
        const baseline = await repository.ensureBaseline({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: anchor('chat-1', null),
        })
        await repository.publishChanges({
            characterId: 'character',
            chatId: 'chat-1',
            operationId: 'external-edit-publish',
            kind: 'analysis',
            expectedHead: baseline.commitId,
            changes: [
                { path: 'characters/one.md', contents: 'one-v2' },
                { path: 'locations/two.md', contents: 'two-v2' },
            ],
        })
        const failure = failOneRename('/locations/two.md')
        const interrupted = createWikiVcsRepository(root, {
            fileSystem: failure.fileSystem,
        })
        await expect(interrupted.checkout({
            characterId: 'character',
            chatId: 'chat-1',
            commitId: baseline.commitId!,
        })).rejects.toMatchObject({ code: 'EIO' })
        const workspace = resolveWikiVcsRepository(root, 'character', 'chat-1')
        await fs.writeFile(
            join(workspace.workingTreeDirectory, 'locations/two.md'),
            'external-after-crash'
        )

        const restarted = createWikiVcsRepository(root)
        const conflicted = await restarted.recoverOperations({
            characterId: 'character',
            chatId: 'chat-1',
        })
        expect(conflicted.completed).toEqual([])
        expect(conflicted.unresolved).toHaveLength(1)
        expect(conflicted.conflicts).toHaveLength(1)
        expect(conflicted.conflicts?.[0]).toContain('locations/two.md')
        expect(conflicted.conflicts?.[0]).toContain('Restore the path')
        expect(await fs.readFile(
            join(workspace.workingTreeDirectory, 'locations/two.md'), 'utf8'
        )).toBe('external-after-crash')
        await expect(restarted.ensureRepository(
            'character', 'chat-1'
        )).rejects.toThrow('Wiki operation pending:')

        // Restoring the journal's before-state lets recovery safely finish.
        await fs.writeFile(
            join(workspace.workingTreeDirectory, 'locations/two.md'), 'two-v2'
        )
        const recovered = await restarted.recoverOperations({
            characterId: 'character',
            chatId: 'chat-1',
        })
        expect(recovered.completed).toEqual(conflicted.unresolved)
        expect(recovered.unresolved).toEqual([])
        expect(recovered.conflicts).toBeUndefined()
        expect(await fs.readFile(
            join(workspace.workingTreeDirectory, 'locations/two.md'), 'utf8'
        )).toBe('two-v1')

        await fs.writeFile(
            join(workspace.workingTreeDirectory, 'locations/two.md'),
            'external-after-recovery'
        )
        const captured = await restarted.captureExternalChanges({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: anchor('chat-1'),
        })
        expect(captured.changedPaths).toEqual(['locations/two.md'])
    })

    test('recovery ignores a pending journal owned by a sibling fork', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'source', {
            'characters/one.md': 'one-v1',
            'locations/two.md': 'two-v1',
        })
        const baseline = await repository.ensureBaseline({
            characterId: 'character',
            chatId: 'source',
            chatAnchor: anchor('source', null),
        })
        await repository.fork({
            characterId: 'character',
            sourceChatId: 'source',
            destinationChatId: 'chat-a',
            commitId: baseline.commitId!,
        })
        await repository.fork({
            characterId: 'character',
            sourceChatId: 'source',
            destinationChatId: 'chat-b',
            commitId: baseline.commitId!,
        })
        const failure = failOneRename('/locations/two.md')
        const writer = createWikiVcsRepository(root, {
            fileSystem: failure.fileSystem,
        })
        await expect(writer.publishChanges({
            characterId: 'character',
            chatId: 'chat-a',
            operationId: 'chat-a-interrupted',
            kind: 'analysis',
            expectedHead: baseline.commitId,
            changes: [
                { path: 'characters/one.md', contents: 'one-a' },
                { path: 'locations/two.md', contents: 'two-a' },
            ],
        })).rejects.toMatchObject({ code: 'EIO' })

        const restarted = createWikiVcsRepository(root)
        expect(await restarted.recoverOperations({
            characterId: 'character',
            chatId: 'chat-b',
        })).toEqual({
            completed: [], discarded: [], unresolved: [],
        })
        const workspaceB = resolveWikiVcsRepository(root, 'character', 'chat-b')
        expect(await fs.readFile(
            join(workspaceB.workingTreeDirectory, 'characters/one.md'), 'utf8'
        )).toBe('one-v1')
        expect((await restarted.ensureRepository(
            'character', 'chat-b'
        )).head).toBe(baseline.commitId)
        const recoveredA = await restarted.recoverOperations({
            characterId: 'character',
            chatId: 'chat-a',
        })
        expect(recoveredA.completed).toEqual(['chat-a-interrupted'])
    })

    test('keeps on-disk external edits instead of overwriting them', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'chat-1', { 'characters/aria.md': 'v1' })
        const baseline = await repository.ensureBaseline({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: anchor('chat-1', null),
        })
        await writeWorkingTree(root, 'chat-1', { 'characters/aria.md': 'edited-on-disk' })

        const captured = await repository.captureExternalChanges({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: anchor('chat-1'),
        })
        expect(captured.commitId).not.toBeNull()
        expect(captured.changedPaths).toEqual(['characters/aria.md'])

        // The external edit is preserved when rewinding to the baseline.
        await repository.checkout({
            characterId: 'character',
            chatId: 'chat-1',
            commitId: baseline.commitId!,
        })
        const workspace = resolveWikiVcsRepository(root, 'character', 'chat-1')
        expect(await fs.readFile(
            join(workspace.workingTreeDirectory, 'characters', 'aria.md'), 'utf8'
        )).toBe('v1')
        const recovery = await repository.listRefs({
            characterId: 'character',
            chatId: 'chat-1',
            kind: 'recovery',
        })
        expect(recovery).toHaveLength(1)
    })

    test('rejects a commit whose expected head no longer matches', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'chat-1', { 'characters/aria.md': 'v1' })
        const baseline = await repository.ensureBaseline({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: anchor('chat-1', null),
        })
        await repository.commit({
            characterId: 'character',
            chatId: 'chat-1',
            operationId: 'turn-1',
            expectedHead: baseline.commitId,
            kind: 'analysis',
            chatAnchor: anchor('chat-1'),
            changes: [{ path: 'characters/aria.md', contents: 'v2' }],
        })
        await expect(repository.commit({
            characterId: 'character',
            chatId: 'chat-1',
            operationId: 'turn-2',
            expectedHead: baseline.commitId,
            kind: 'analysis',
            chatAnchor: anchor('chat-1'),
            changes: [{ path: 'characters/aria.md', contents: 'v3' }],
        })).rejects.toThrow(/conflict/)
    })

    test('retains valid path maps through a long commit sequence', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'chat-1', {
            'characters/sequence.md': 'version-0',
        })
        const baseline = await repository.ensureBaseline({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: anchor('chat-1', null),
        })
        let expectedHead = baseline.commitId!
        const commits: string[] = []
        for (let version = 1; version <= 40; version += 1) {
            const receipt = await repository.commit({
                characterId: 'character',
                chatId: 'chat-1',
                operationId: `sequence-${version}`,
                expectedHead,
                kind: 'manual',
                chatAnchor: anchor('chat-1', `message-${version}`),
                changes: [{
                    path: 'characters/sequence.md',
                    contents: `version-${version}`,
                }],
            })
            expectedHead = receipt.commitId
            commits.push(receipt.commitId)
        }

        expect((await repository.readPathMap(
            'character', 'chat-1', commits[0]
        ))['characters/sequence.md']).toBe(
            createHash('sha256').update('version-1').digest('hex')
        )
        expect((await repository.readPathMap(
            'character', 'chat-1', commits[19]
        ))['characters/sequence.md']).toBe(
            createHash('sha256').update('version-20').digest('hex')
        )
        const restarted = createWikiVcsRepository(root)
        expect((await restarted.readPathMap(
            'character', 'chat-1', commits[0]
        ))['characters/sequence.md']).toBe(
            createHash('sha256').update('version-1').digest('hex')
        )
        expect((await restarted.readPathMap(
            'character', 'chat-1', commits[19]
        ))['characters/sequence.md']).toBe(
            createHash('sha256').update('version-20').digest('hex')
        )
        expect((await restarted.readPathMap(
            'character', 'chat-1', commits[39]
        ))['characters/sequence.md']).toBe(
            createHash('sha256').update('version-40').digest('hex')
        )
        expect((await restarted.ensureRepository(
            'character', 'chat-1'
        )).head).toBe(commits[39])
        await restarted.checkout({
            characterId: 'character',
            chatId: 'chat-1',
            commitId: commits[0],
        })
        expect(await fs.readFile(join(
            resolveWikiVcsRepository(root, 'character', 'chat-1')
                .workingTreeDirectory,
            'characters/sequence.md'
        ), 'utf8')).toBe('version-1')
    })

    test('afterWrite recovers its durable capture before pending lookup', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'chat-1', {
            'characters/aria.md': 'v1',
        })
        const baseline = await repository.ensureBaseline({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: anchor('chat-1', null),
        })
        await fs.writeFile(
            join(
                resolveWikiVcsRepository(root, 'character', 'chat-1')
                    .workingTreeDirectory,
                'characters/aria.md'
            ),
            'v2'
        )
        const branchFile = join(
            resolveWikiVcsRepository(root, 'character', 'chat-1')
                .branchesDirectory,
            `${Buffer.from('branch:chat-1').toString('base64url')}.json`
        )
        const failure = failOneRename(branchFile)
        const versioning = createWikiVersioning(root, {
            fileSystem: failure.fileSystem,
        })
        const captured = await versioning.afterWrite({
            characterId: 'character',
            chatId: 'chat-1',
            kind: 'manual',
            operationId: 'after-write-recovery',
            expectedHead: baseline.commitId,
            chatAnchor: anchor('chat-1'),
        })

        expect(failure.didFail()).toBe(true)
        expect(captured.commitId).not.toBeNull()
        expect(captured.changedPaths).toEqual(['characters/aria.md'])
        expect((await versioning.readHead(
            'character', 'chat-1'
        ))).toBe(captured.commitId)
        expect(await fs.readFile(
            join(
                resolveWikiVcsRepository(root, 'character', 'chat-1')
                    .workingTreeDirectory,
                'characters/aria.md'
            ),
            'utf8'
        )).toBe('v2')
    })

    test('replaying the same operation ID returns the recorded commit', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'chat-1', { 'characters/aria.md': 'v1' })
        const baseline = await repository.ensureBaseline({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: anchor('chat-1', null),
        })
        const input = {
            characterId: 'character',
            chatId: 'chat-1',
            operationId: 'turn-1',
            expectedHead: baseline.commitId,
            kind: 'analysis' as const,
            chatAnchor: anchor('chat-1'),
            changes: [{ path: 'characters/aria.md', contents: 'v2' }],
        }
        const first = await repository.commit(input)
        const repeated = await repository.commit(input)
        expect(repeated.commitId).toBe(first.commitId)
        expect(await repository.listHistory({
            characterId: 'character', chatId: 'chat-1',
        })).toHaveLength(2)
    })

    test('garbage collection keeps blobs reachable from refs and branches', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'chat-1', { 'characters/aria.md': 'v1' })
        const baseline = await repository.ensureBaseline({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: anchor('chat-1', null),
        })
        const committed = await repository.commit({
            characterId: 'character',
            chatId: 'chat-1',
            operationId: 'turn-1',
            expectedHead: baseline.commitId,
            kind: 'analysis',
            chatAnchor: anchor('chat-1'),
            changes: [{ path: 'characters/aria.md', contents: 'v2' }],
        })
        await repository.checkout({
            characterId: 'character',
            chatId: 'chat-1',
            commitId: baseline.commitId!,
            reason: 'truncate',
        })
        const collected = await repository.collectGarbage({
            characterId: 'character', chatId: 'chat-1',
        })
        expect(collected.deletedObjects).toBe(0)
        // The rewind target and the saved future are both still readable.
        expect(await repository.readPathMap(
            'character', 'chat-1', baseline.commitId!
        )).toBeTruthy()
        expect(await repository.readPathMap(
            'character', 'chat-1', committed.commitId
        )).toBeTruthy()
    })

    test('keeps checkpointed history replayable after many commits', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'chat-1', { 'characters/aria.md': 'v0' })
        let head = (await repository.ensureBaseline({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: anchor('chat-1', null),
        })).commitId
        const heads: string[] = []
        for (let index = 1; index <= 20; index += 1) {
            const receipt = await repository.commit({
                characterId: 'character',
                chatId: 'chat-1',
                operationId: `turn-${index}`,
                expectedHead: head,
                kind: 'analysis',
                chatAnchor: anchor('chat-1', `message-${index}`),
                changes: [{ path: 'characters/aria.md', contents: `v${index}` }],
            })
            head = receipt.commitId
            heads.push(receipt.commitId)
        }
        const receipt = await repository.readCommit(
            'character', 'chat-1', heads[19]
        )
        expect(receipt).toBeTruthy()
        // Deepest checkpoint must still resolve the earliest content exactly.
        const paths = await repository.readPathMap(
            'character', 'chat-1', heads[19]
        )
        expect(paths['characters/aria.md']).toBeTruthy()
        await repository.checkout({
            characterId: 'character',
            chatId: 'chat-1',
            commitId: heads[4],
        })
        const workspace = resolveWikiVcsRepository(root, 'character', 'chat-1')
        expect(await fs.readFile(
            join(workspace.workingTreeDirectory, 'characters', 'aria.md'), 'utf8'
        )).toBe('v5')
    })

    test('finds a commit boundary by compatible chat prefix checkpoints', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'chat-1', { 'characters/aria.md': 'v1' })
        const baseline = await repository.ensureBaseline({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: chatBoundaryAnchor('chat-1', null, []),
        })
        const committed = await repository.commit({
            characterId: 'character',
            chatId: 'chat-1',
            operationId: 'turn-1',
            expectedHead: baseline.commitId,
            kind: 'analysis',
            chatAnchor: anchor('chat-1', 'message-1'),
            changes: [{ path: 'characters/aria.md', contents: 'v2' }],
        })
        expect(await repository.findCommitForPrefixes({
            characterId: 'character',
            chatId: 'chat-1',
            prefixes: [{
                messageId: 'message-1',
                prefixDigest: anchor('chat-1', 'message-1').prefixDigest,
            }],
            minimumBoundaryMessageId: 'message-1',
        })).toBe(committed.commitId)
        expect(await repository.findCommitForPrefixes({
            characterId: 'character',
            chatId: 'chat-1',
            prefixes: [{
                messageId: 'message-2',
                prefixDigest: anchor('chat-1', 'message-2').prefixDigest,
            }],
            minimumBoundaryMessageId: 'message-2',
        })).toBeNull()
    })

    test('rejects a short-prefix commit whose parent contains future state', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'chat-1', { 'characters/aria.md': 'base' })
        const firstMessages = [
            { messageId: 'user-1', role: 'user', data: 'start' },
            { messageId: 'assistant-1', role: 'assistant', data: 'first state' },
        ]
        const fullMessages = [
            ...firstMessages,
            { messageId: 'user-2', role: 'user', data: 'continue' },
            { messageId: 'assistant-2', role: 'assistant', data: 'future state' },
        ]
        const base = await repository.ensureBaseline({
            characterId: 'character',
            chatId: 'chat-1',
            chatAnchor: chatBoundaryAnchor(
                'chat-1', 'assistant-1', firstMessages
            ),
        })
        const future = await repository.commit({
            characterId: 'character',
            chatId: 'chat-1',
            operationId: 'future-state',
            expectedHead: base.commitId,
            kind: 'analysis',
            chatAnchor: chatBoundaryAnchor(
                'chat-1', 'assistant-2', fullMessages
            ),
            changes: [{ path: 'locations/future.md', contents: 'from future' }],
        })
        const reanalyzed = await repository.commit({
            characterId: 'character',
            chatId: 'chat-1',
            operationId: 'stale-short-state',
            expectedHead: future.commitId,
            kind: 'analysis',
            chatAnchor: chatBoundaryAnchor(
                'chat-1', 'assistant-1', firstMessages
            ),
            changes: [{ path: 'characters/stale.md', contents: 'short prefix' }],
        })
        const digests = computeWikiPrefixDigests(firstMessages)
        const selected = await repository.findCommitForPrefixes({
            characterId: 'character',
            chatId: 'chat-1',
            prefixes: firstMessages.map((message, index) => ({
                messageId: message.messageId,
                prefixDigest: digests[index],
            })),
            minimumBoundaryMessageId: 'assistant-1',
        })
        expect(selected).toBe(base.commitId)
        const paths = await repository.readPathMap(
            'character', 'chat-1', selected!
        )
        expect(paths['locations/future.md']).toBeUndefined()
        expect(paths['characters/stale.md']).toBeUndefined()
        const fullDigests = computeWikiPrefixDigests(fullMessages)
        expect(await repository.findCommitForPrefixes({
            characterId: 'character',
            chatId: 'chat-1',
            prefixes: fullMessages.map((message, index) => ({
                messageId: message.messageId,
                prefixDigest: fullDigests[index],
            })),
            minimumBoundaryMessageId: 'assistant-2',
        })).toBe(reanalyzed.commitId)
        const preview = await repository.previewCheckout({
            characterId: 'character',
            chatId: 'chat-1',
            commitId: reanalyzed.commitId!,
            messages: fullMessages,
        })
        expect(preview.exact).toBe(true)
        expect(preview.chatAnchor.boundaryMessageId).toBe('assistant-2')
    })
    test('records unchanged confirmed boundaries and retries their durable publication', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        const scope = { characterId: 'character', chatId: 'chat-1' }
        await writeWorkingTree(root, 'chat-1', { 'characters/aria.md': 'Unchanged story' })
        const messages = [
            { messageId: 'm1', role: 'assistant' as const, data: 'Aria arrived.' },
            { messageId: 'm2', role: 'assistant' as const, data: 'Aria waited.' },
        ]
        const baseline = await repository.ensureBaseline({
            ...scope, chatAnchor: chatBoundaryAnchor('chat-1', 'm1', messages.slice(0, 1)),
        })
        const input = {
            ...scope, operationId: 'quiet-turn', kind: 'analysis' as const,
            expectedHead: baseline.commitId, changes: [],
            chatAnchor: chatBoundaryAnchor('chat-1', 'm2', messages),
        }
        const published = await repository.publishChanges(input)
        expect(published.commitId).not.toBe(baseline.commitId)
        expect(await repository.readPathMap('character', 'chat-1', published.commitId!))
            .toEqual(await repository.readPathMap('character', 'chat-1', baseline.commitId!))
        const reopened = createWikiVcsRepository(root)
        expect(await reopened.publishChanges(input)).toEqual(published)
        const versioning = createWikiVersioning(root, { loadChatAnchor: async () => undefined })
        expect(await versioning.publishChanges(input)).toEqual(published)
        const digests = computeWikiPrefixDigests(messages)
        expect(await reopened.findCommitForPrefixes({
            ...scope, minimumBoundaryMessageId: 'm2',
            prefixes: messages.map((message, index) => ({
                messageId: message.messageId, prefixDigest: digests[index],
            })),
        })).toBe(published.commitId)
        expect((await reopened.listHistory(scope))[0].boundaryMessageId).toBe('m2')
    })

    test('rejects a deleted source chat before publishing staged analysis', async () => {
        const root = await createRoot()
        const expected = anchor('chat-1')
        let current: typeof expected | undefined = expected
        const versioning = createWikiVersioning(root, { loadChatAnchor: async () => current })
        const scope = { characterId: 'character', chatId: 'chat-1' }
        await writeWorkingTree(root, 'chat-1', { 'characters/aria.md': 'Before deletion' })
        const baseline = await versioning.ensureBaseline({ ...scope, chatAnchor: expected })
        current = undefined
        await expect(versioning.publishChanges({
            ...scope, operationId: 'deleted-source', kind: 'analysis',
            expectedHead: baseline.commitId, chatAnchor: expected,
            changes: [{ path: 'characters/aria.md', contents: 'Late result' }],
        })).rejects.toThrow('persisted source chat is missing')
        expect((await versioning.listHistory(scope))[0].commitId).toBe(baseline.commitId)
        expect(await fs.readFile(join(
            resolveWikiVcsRepository(root, 'character', 'chat-1').workingTreeDirectory,
            'characters/aria.md',
        ), 'utf8')).toBe('Before deletion')
    })

    test('preserves unrelated external edits and captures a conflicting target before rejecting', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        const scope = { characterId: 'character', chatId: 'chat-1' }
        await writeWorkingTree(root, 'chat-1', { 'characters/aria.md': 'Old Aria', 'locations/keep.md': 'Old keep' })
        const baseline = await repository.ensureBaseline({ ...scope, chatAnchor: anchor('chat-1') })
        await writeWorkingTree(root, 'chat-1', { 'locations/keep.md': 'External keep' })
        const published = await repository.publishChanges({
            ...scope, operationId: 'internal-write', kind: 'manual', expectedHead: baseline.commitId,
            chatAnchor: anchor('chat-1'), changes: [{ path: 'characters/aria.md', contents: 'New Aria' }],
        })
        const workspace = resolveWikiVcsRepository(root, 'character', 'chat-1')
        expect(await fs.readFile(join(workspace.workingTreeDirectory, 'locations/keep.md'), 'utf8')).toBe('External keep')
        await writeWorkingTree(root, 'chat-1', { 'characters/aria.md': 'External Aria' })
        await expect(repository.publishChanges({
            ...scope, operationId: 'stale-write', kind: 'manual', expectedHead: published.commitId,
            chatAnchor: anchor('chat-1'), changes: [{ path: 'characters/aria.md', contents: 'Would erase external edit' }],
        })).rejects.toThrow('working path changed')
        const captured = (await repository.listHistory(scope))[0]
        expect(captured.kind).toBe('external')
        expect(captured.changedPaths).toEqual(['characters/aria.md', 'locations/keep.md'])
        expect(await fs.readFile(join(workspace.workingTreeDirectory, 'characters/aria.md'), 'utf8')).toBe('External Aria')
    })

})

describe('repository retention and isolation', () => {
    test('GC retains pre-checkpoint versions needed for historical checkout', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'chat-1', { 'characters/aria.md': 'baseline' })
        const baseline = await repository.ensureBaseline({
            characterId: 'character', chatId: 'chat-1', chatAnchor: anchor('chat-1'),
        })
        const commits = [baseline.commitId!]
        for (let index = 0; index < 20; index += 1) {
            const receipt = await repository.commit({
                characterId: 'character', chatId: 'chat-1', operationId: `turn:${index}`,
                kind: 'analysis', chatAnchor: anchor('chat-1', `message-${index}`),
                changes: [{ path: 'characters/aria.md', contents: `version-${index}` }],
            })
            commits.push(receipt.commitId)
        }
        await repository.collectGarbage({ characterId: 'character', chatId: 'chat-1' })
        const reopened = createWikiVcsRepository(root)
        expect((await reopened.listHistory({
            characterId: 'character', chatId: 'chat-1',
        })).map((entry) => entry.commitId)).toEqual([...commits].reverse())
        await reopened.checkout({
            characterId: 'character', chatId: 'chat-1', commitId: commits[4],
        })
        const workspace = resolveWikiVcsRepository(root, 'character', 'chat-1')
        expect(await fs.readFile(
            join(workspace.workingTreeDirectory, 'characters/aria.md'), 'utf8'
        )).toBe('version-3')
    })

    test('fork rejects a symlinked destination without writing outside the workspace', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        await writeWorkingTree(root, 'source', { 'characters/aria.md': 'story' })
        const baseline = await repository.ensureBaseline({
            characterId: 'character', chatId: 'source', chatAnchor: anchor('source'),
        })
        const destination = resolveWikiVcsRepository(root, 'character', 'destination')
        const outside = join(root, 'outside')
        await fs.mkdir(outside)
        await fs.mkdir(destination.workingTreeDirectory, { recursive: true })
        await fs.symlink(outside, join(destination.workingTreeDirectory, 'characters'))
        await expect(repository.fork({
            characterId: 'character', sourceChatId: 'source',
            destinationChatId: 'destination', commitId: baseline.commitId!,
        })).rejects.toThrow('symlink')
        await expect(fs.access(join(outside, 'aria.md')))
            .rejects.toMatchObject({ code: 'ENOENT' })
        await expect(fs.access(destination.linkFile))
            .rejects.toMatchObject({ code: 'ENOENT' })
    })

    test('refs cannot be listed or deleted through another chat', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        const baseline = await repository.ensureBaseline({
            characterId: 'character', chatId: 'owner', chatAnchor: anchor('owner'),
        })
        const id = await repository.createRef({
            characterId: 'character', chatId: 'owner', commitId: baseline.commitId!,
            kind: 'recovery', reason: 'chat-delete',
        })
        expect(await repository.listRefs({
            characterId: 'character', chatId: 'another', kind: 'recovery',
        })).toEqual([])
        await expect(repository.deleteRef({
            characterId: 'character', chatId: 'another', kind: 'recovery', id,
        })).rejects.toThrow('belongs to another chat')
        expect((await repository.listRefs({
            characterId: 'character', chatId: 'owner', kind: 'recovery',
        })).map((ref) => ref.id)).toEqual([id])
    })

    test('chunked chat recovery reuses unchanged messages and retains shared chunks during GC', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        const packer = new Packr({ useRecords: false })
        const unpacker = new Unpackr({ useRecords: false })
        const first = {
            id: 'chat-1', name: 'Story', scriptstate: { mood: 7 },
            message: [{ chatId: 'm1', role: 'char', data: 'Long retained story'.repeat(100) }],
        }
        const second = { ...first, message: [
            ...first.message, { chatId: 'm2', role: 'user', data: 'Continue.' },
        ] }
        const firstHash = await repository.storeChatState({
            characterId: 'character', chatId: 'chat-1',
            contents: packer.pack(first).toString('base64'),
        })
        const secondHash = await repository.storeChatState({
            characterId: 'character', chatId: 'chat-1',
            contents: packer.pack(second).toString('base64'),
        })
        await repository.collectChatState({
            characterId: 'character', chatId: 'chat-1', referencedHashes: [secondHash],
        })
        const restored = await repository.readChatState({
            characterId: 'character', chatId: 'chat-1', hash: secondHash,
        })
        expect(unpacker.unpack(Buffer.from(restored!, 'base64'))).toEqual(second)
        expect(await repository.readChatState({
            characterId: 'character', chatId: 'chat-1', hash: firstHash,
        })).toBeNull()
    })
})

describe('VCS synchronization regression', () => {
    test('restores immutable chat states across tree growth, edits, truncation and shared-root collection', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        const input = { characterId: 'character', chatId: 'chat-1' }
        const packer = new Packr({ useRecords: false })
        const unpacker = new Unpackr({ useRecords: false })
        const messages = Array.from({ length: 2049 }, (_, index) => ({
            chatId: `m${index}`, role: index % 2 ? 'char' : 'user', data: `Message ${index}`,
        }))
        const retained = { id: 'chat-1', name: 'Retained', message: messages.slice(0, 64) }
        const retainedHash = await repository.storeChatState({ ...input, contents: packer.pack(retained).toString('base64') })
        const snapshots = [
            ...[0, 1, 64, 65, 2048, 2049].map(count => ({ ...retained, message: messages.slice(0, count) })),
            { ...retained, name: 'Edited header', message: messages },
            { ...retained, message: messages.map((message, index) => index === 70
                ? { ...message, data: 'Edited middle message' } : message) },
            ...[2048, 65, 64, 1, 0].map(count => ({ ...retained, message: messages.slice(0, count) })),
        ]
        let latest = retainedHash
        for (const snapshot of snapshots) {
            latest = await repository.storeChatState({ ...input, contents: packer.pack(snapshot).toString('base64') })
            await repository.collectChatState({ ...input, referencedHashes: [retainedHash, latest] })
            const restarted = createWikiVcsRepository(root)
            const restored = await restarted.readChatState({ ...input, hash: latest })
            expect(unpacker.unpack(Buffer.from(restored!, 'base64'))).toEqual(snapshot)
            expect(unpacker.unpack(Buffer.from((await restarted.readChatState({ ...input, hash: retainedHash }))!, 'base64')))
                .toEqual(retained)
        }
        await repository.collectChatState({ ...input, referencedHashes: [latest] })
        expect(await createWikiVcsRepository(root).readChatState({ ...input, hash: retainedHash })).toBeNull()
    }, 60_000)

    test('reads legacy flat manifests through collection and rejects corrupt shared message objects', async () => {
        const root = await createRoot()
        const repository = createWikiVcsRepository(root)
        const input = { characterId: 'character', chatId: 'chat-1' }
        const packer = new Packr({ useRecords: false })
        const unpacker = new Unpackr({ useRecords: false })
        const chat = { id: 'chat-1', name: 'Legacy story',
            message: [{ chatId: 'm1', role: 'char', data: 'Saved before tree manifests existed.' }] }
        const directory = join(resolveWikiVcsRepository(root, 'character', 'chat-1').directory, 'chat-state')
        await fs.mkdir(directory, { recursive: true })
        const storeLegacyObject = async (contents: string) => {
            const hash = createHash('sha256').update(contents).digest('hex')
            await fs.writeFile(join(directory, hash), contents)
            return hash
        }
        const { message, ...header } = chat
        const messageHash = await storeLegacyObject(packer.pack(message[0]).toString('base64'))
        const legacyHash = await storeLegacyObject(JSON.stringify({ schemaVersion: 2,
            header: await storeLegacyObject(packer.pack(header).toString('base64')), messages: [messageHash] }))
        const treeHash = await repository.storeChatState({ ...input, contents: packer.pack(chat).toString('base64') })
        await repository.collectChatState({ ...input, referencedHashes: [legacyHash, treeHash] })
        for (const hash of [legacyHash, treeHash]) {
            const restored = await createWikiVcsRepository(root).readChatState({ ...input, hash })
            expect(unpacker.unpack(Buffer.from(restored!, 'base64'))).toEqual(chat)
        }
        await fs.writeFile(join(directory, messageHash), 'corrupt bytes')
        for (const hash of [legacyHash, treeHash]) {
            await expect(createWikiVcsRepository(root).readChatState({ ...input, hash })).rejects.toThrow(/corrupt/)
        }
    })
})
