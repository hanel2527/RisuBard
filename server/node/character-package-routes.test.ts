import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { registerCharacterPackageRoutes } = require('./character-package-routes.cjs')
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createCanonicalProjectionSync } = require('./canonical-projection-sync.cjs')
const { atomicWriteJson } = require('./file-store.cjs')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

function fixture() {
    const routes: Record<string, Function> = {}
    const repository = {
        characterDirectoryStatus: vi.fn(() => ({ enabled: false, directory: 'one', chats: 0 })),
        publishCharacterDirectoryMapping: vi.fn(() => ({ directory: 'One' })),
        refreshCharacterDirectoryMapping: vi.fn(),
        rollbackCharacterDirectoryMapping: vi.fn(),
    }
    const assets = {
        status: vi.fn(() => ({ enabled: false, copied: 0, skipped: 0, failed: 0 })),
        diagnostics: vi.fn(() => ({ reads: 0, fallbacks: 0 })),
        migrate: vi.fn(), disable: vi.fn(), reload: vi.fn(),
    }
    const deps = {
        auth: vi.fn(async () => true), activeSession: vi.fn(() => true),
        queue: vi.fn(async fn => fn()), prepare: vi.fn(async () => ({ characters: [{ chaId: 'one' }] })),
        repository, assets, readSource: vi.fn(), acceptTransition: vi.fn(), recordTransition: vi.fn(),
    }
    registerCharacterPackageRoutes({
        get: (path, handler) => routes[`GET ${path}`] = handler,
        post: (path, handler) => routes[`POST ${path}`] = handler,
    }, deps)
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    return { deps, repository, assets, res, get: routes['GET /api/character-packages/status'], post: routes['POST /api/character-packages/transition'] }
}

it('migrates assets before publishing the selected package mapping', async () => {
    const { deps, repository, assets, res, post } = fixture()
    await post({ body: { characterId: 'one', action: 'migrate' } }, res)
    expect(assets.migrate).toHaveBeenCalledWith({ characters: [{ chaId: 'one' }] }, 'one', deps.readSource)
    expect(repository.publishCharacterDirectoryMapping).toHaveBeenCalledWith('one')
    expect(assets.migrate.mock.invocationCallOrder[0]).toBeLessThan(repository.publishCharacterDirectoryMapping.mock.invocationCallOrder[0])
})

it('flushes before rollback and disables the asset replica after restoring legacy paths', async () => {
    const { repository, assets, res, post } = fixture()
    repository.characterDirectoryStatus.mockReturnValue({ enabled: true, directory: 'One', chats: 1 })
    await post({ body: { characterId: 'one', action: 'rollback' } }, res)
    expect(repository.rollbackCharacterDirectoryMapping).toHaveBeenCalledWith('one')
    expect(assets.reload).toHaveBeenCalled()
    expect(assets.disable).toHaveBeenCalledWith('one')
})

it('requires authentication, writer ownership and valid canonical data', async () => {
    const { deps, res, post } = fixture()
    deps.activeSession.mockReturnValue(false)
    await post({ body: { characterId: 'one', action: 'migrate' } }, res)
    expect(deps.queue).not.toHaveBeenCalled()
    deps.activeSession.mockReturnValue(true)
    await post({ body: { characterId: 'one', action: 'invalid' } }, res)
    expect(res.status).toHaveBeenCalledWith(400)
    deps.prepare.mockResolvedValue(null)
    await post({ body: { characterId: 'one', action: 'migrate' } }, res)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(deps.recordTransition).not.toHaveBeenCalled()
})

it.each(['migrate', 'refresh', 'rollback'])('records a successful %s without character identifiers', async action => {
    const { deps, res, post } = fixture()
    await post({ body: { characterId: 'one', action } }, res)
    expect(deps.recordTransition).toHaveBeenCalledExactlyOnceWith({
        kind: 'character-package-transition', trigger: action, outcome: 'success',
    })
})

it('records transition failure without exposing raw errors or counting a success', async () => {
    const { deps, repository, res, post } = fixture()
    repository.publishCharacterDirectoryMapping.mockImplementation(() => { throw new Error('private path and name') })
    await post({ body: { characterId: 'one', action: 'migrate' } }, res)
    expect(deps.recordTransition).toHaveBeenCalledExactlyOnceWith({
        kind: 'character-package-transition', trigger: 'migrate', outcome: 'failure',
        errorCode: 'CHARACTER_PACKAGE_TRANSITION_FAILED',
    })
    expect(res.status).toHaveBeenCalledWith(500)
})

it('does not fail a successful transition when observation fails', async () => {
    const { deps, res, post } = fixture()
    deps.recordTransition.mockImplementation(() => { throw new Error('observation unavailable') })
    await post({ body: { characterId: 'one', action: 'migrate' } }, res)
    expect(res.status).not.toHaveBeenCalled()
    expect(deps.recordTransition).toHaveBeenCalledTimes(1)
})

it.each(['migrate', 'refresh', 'rollback'])('accepts %s before subsequent asset work can fail', async action => {
    const { deps, repository, assets, res, post } = fixture()
    repository.characterDirectoryStatus.mockReturnValue({ enabled: action !== 'migrate', directory: 'One', chats: 1 })
    assets.reload.mockImplementation(() => { throw new Error('asset reload failed') })
    await post({ body: { characterId: 'one', action } }, res)
    expect(deps.acceptTransition).toHaveBeenCalledTimes(1)
    expect(deps.acceptTransition.mock.invocationCallOrder[0]).toBeLessThan(assets.reload.mock.invocationCallOrder[0])
    expect(res.status).toHaveBeenCalledWith(500)
})

it.each([false, true])('accepts a repository failure only when recovery is explicitly confirmed (%s)', async recovered => {
    const { deps, repository, res, post } = fixture()
    repository.publishCharacterDirectoryMapping.mockImplementation(() => {
        throw Object.assign(new Error('private filesystem path'), { canonicalTransitionRecovered: recovered })
    })
    await post({ body: { characterId: 'one', action: 'migrate' } }, res)
    expect(deps.acceptTransition).toHaveBeenCalledTimes(recovered ? 1 : 0)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'CHARACTER_PACKAGE_TRANSITION_FAILED', status: expect.objectContaining({ enabled: false }),
    }))
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('private filesystem path')
})

function integrationFixture() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'package-route-sync-'))
    roots.push(dataRoot)
    const repository = createUserDataRepository({ dataRoot, allowDirectoryMapping: true })
    repository.importLegacyDatabase({ characters: [{ chaId: 'one', name: 'Alice', chats: [{ id: 'chat-one', name: 'First chat', message: [{ role: 'user', data: 'hello' }] }] }] })
    let accepted: string | null = null
    const sync = createCanonicalProjectionSync({ repository,
        readAcceptedRevision: () => accepted, writeAcceptedRevision: (revision: string) => { accepted = revision },
    })
    sync.accept()
    const { deps } = fixture()
    let post: Function
    registerCharacterPackageRoutes({ get: () => {}, post: (_path: string, handler: Function) => { post = handler } }, {
        ...deps, repository, acceptTransition: () => sync.accept(),
        prepare: async () => sync.hasExternalChanges() ? null : repository.exportLegacyDatabase(),
    })
    const transition = async (action: string) => {
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
        await post({ body: { characterId: 'one', action } }, res)
        return res
    }
    return { dataRoot, repository, sync, transition }
}

it('keeps migrate, save, refresh, rollback, save and retransition writable with real canonical files', async () => {
    const { repository, sync, transition } = integrationFixture()
    expect((await transition('migrate')).status).not.toHaveBeenCalled()
    expect(sync.hasExternalChanges()).toBe(false)
    const edited = repository.exportLegacyDatabase()
    edited.characters[0].name = 'Renamed'
    edited.characters[0].chats[0].message.push({ role: 'char', data: 'saved after migration' })
    repository.importLegacyDatabase(edited, { mode: 'sync' })
    sync.accept()
    expect((await transition('refresh')).status).not.toHaveBeenCalled()
    expect(sync.hasExternalChanges()).toBe(false)
    expect((await transition('rollback')).status).not.toHaveBeenCalled()
    expect(sync.hasExternalChanges()).toBe(false)
    edited.characters[0].chats[0].message.push({ role: 'user', data: 'saved after rollback' })
    repository.importLegacyDatabase(edited, { mode: 'sync' })
    sync.accept()
    expect((await transition('migrate')).status).not.toHaveBeenCalled()
    expect(sync.hasExternalChanges()).toBe(false)
    expect(repository.exportLegacyDatabase()).toEqual(edited)
})

it('still rejects real external canonical edits without accepting their revision', async () => {
    const { dataRoot, repository, sync, transition } = integrationFixture()
    await transition('migrate')
    const before = repository.getProjectionRevision()
    const directory = repository.characterDirectoryStatus('one').directory
    const relative = `characters/${directory}/metadata.json`
    const metadata = JSON.parse(fs.readFileSync(path.join(dataRoot, relative), 'utf8'))
    atomicWriteJson(dataRoot, relative, { ...metadata, name: 'External edit' })
    expect(repository.getProjectionRevision()).not.toBe(before)
    expect((await transition('rollback')).status).toHaveBeenCalledWith(409)
    expect(sync.hasExternalChanges()).toBe(true)
    expect(repository.characterDirectoryStatus('one').enabled).toBe(true)
})
