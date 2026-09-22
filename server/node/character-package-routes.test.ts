import { expect, it, vi } from 'vitest'
const { registerCharacterPackageRoutes } = require('./character-package-routes.cjs')

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
        repository, assets, readSource: vi.fn(),
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
})
