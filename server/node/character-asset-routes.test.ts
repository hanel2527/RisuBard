import { expect, it, vi } from 'vitest'
const { registerCharacterAssetRoutes } = require('./character-asset-routes.cjs')
function fixture() {
    const routes: Record<string, Function> = {}
    const deps = { auth: vi.fn(async () => true), activeSession: vi.fn(() => true), queue: vi.fn(async fn => fn()), prepare: vi.fn(async () => ({ characters: [{ chaId: 'one' }] })), assets: { migrate: vi.fn(() => ({ copied: 1 })), disable: vi.fn(), status: vi.fn(), diagnostics: vi.fn(() => ({ reads: 0 })) }, readSource: vi.fn() }
    registerCharacterAssetRoutes({ get: (path, handler) => routes[`GET ${path}`] = handler, post: (path, handler) => routes[`POST ${path}`] = handler }, deps)
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    return { deps, res, post: routes['POST /api/character-assets/transition'], status: routes['GET /api/character-assets/status'] }
}
it('requires auth, writer ownership and an explicit valid character/action before preparing data', async () => {
    const { deps, res, post } = fixture()
    deps.activeSession.mockReturnValue(false)
    await post({ body: { characterId: 'one', action: 'migrate' } }, res, vi.fn())
    expect(deps.prepare).not.toHaveBeenCalled()
    deps.activeSession.mockReturnValue(true)
    await post({ body: { action: 'migrate' } }, res, vi.fn())
    expect(res.status).toHaveBeenCalledWith(400)
    expect(deps.prepare).not.toHaveBeenCalled()
})
it('rolls back only the requested character without reading unavailable canonical files', async () => {
    const { deps, res, post } = fixture()
    deps.prepare.mockRejectedValue(new Error('Canonical files are broken'))
    deps.assets.disable.mockReturnValue({ enabled: false })
    await post({ body: { characterId: 'removed-character', action: 'disable' } }, res, vi.fn())
    expect(deps.prepare).not.toHaveBeenCalled()
    expect(deps.assets.disable).toHaveBeenCalledExactlyOnceWith('removed-character')
    expect(deps.assets.migrate).not.toHaveBeenCalled()
    expect(deps.queue).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({ enabled: false, diagnostics: { reads: 0 } })
})
it('status is read-only and rollback still requires authentication and writer ownership', async () => {
    const { deps, res, post, status } = fixture()
    await status({ query: { characterId: 'one' } }, res, vi.fn())
    expect(deps.assets.status).toHaveBeenCalledExactlyOnceWith('one')
    expect(deps.assets.disable).not.toHaveBeenCalled()
    expect(deps.assets.migrate).not.toHaveBeenCalled()
    expect(deps.prepare).not.toHaveBeenCalled()
    deps.auth.mockResolvedValue(false)
    await post({ body: { characterId: 'one', action: 'disable' } }, res, vi.fn())
    expect(deps.queue).not.toHaveBeenCalled()
    deps.auth.mockResolvedValue(true)
    deps.activeSession.mockReturnValue(false)
    await post({ body: { characterId: 'one', action: 'disable' } }, res, vi.fn())
    expect(deps.queue).not.toHaveBeenCalled()
    expect(deps.assets.disable).not.toHaveBeenCalled()
})
it('rejects unavailable canonical data and missing characters, then migrates only the selected character', async () => {
    const { deps, res, post } = fixture()
    const req = { body: { characterId: 'one', action: 'migrate' } }
    deps.prepare.mockResolvedValueOnce(null as any)
    await post(req, res, vi.fn())
    expect(res.status).toHaveBeenCalledWith(409)
    await post({ body: { ...req.body, characterId: 'two' } }, res, vi.fn())
    expect(res.status).toHaveBeenCalledWith(404)
    expect(deps.assets.migrate).not.toHaveBeenCalled()
    await post(req, res, vi.fn())
    expect(deps.assets.migrate).toHaveBeenCalledWith({ characters: [{ chaId: 'one' }] }, 'one', deps.readSource)
    expect(deps.queue).toHaveBeenCalledTimes(3)
})
