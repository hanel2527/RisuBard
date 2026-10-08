import { expect, it, vi } from 'vitest'
const { registerModuleAssetRoutes } = require('./module-asset-routes.cjs')

function fixture() {
    const routes: Record<string, Function> = {}
    const assets = {
        moduleStatus: vi.fn(() => ({ enabled: true, directory: 'Fate', copied: 2, failed: 0 })),
        diagnostics: vi.fn(() => ({ reads: 0, fallbacks: 0 })),
        disableModule: vi.fn(), read: vi.fn(),
        prepareModuleCopy: vi.fn(() => ({ id: 'mod' })), copyModule: vi.fn(async () => ({ copied: 2 })),
        publishModuleCopy: vi.fn(), releaseModuleCopy: vi.fn(),
        moduleRetirementPlan: vi.fn(() => ({ entries: [], shared: 3 })),
        verifyModuleRetirement: vi.fn(async () => ({ candidates: [{ key: 'assets/a.png', object: 'a', size: 1 }], shared: 3, unverified: 0 })),
        overview: vi.fn(() => ({ characters: { one: { package: true, assets: true } }, modules: { mod: { enabled: true, copied: 2, failed: 0 } } })),
    }
    const kv = {
        retireAssets: vi.fn(() => ({ retired: 1 })),
        restoreRetiredAssets: vi.fn(() => ({ restored: 1, failed: 0 })),
        retiredStatus: vi.fn(() => ({ retired: 0, bytes: 0 })),
        retiredSummary: vi.fn(() => ({ one: 4, 'module:mod': 1, 'module:gone': 2 })),
    }
    const deps = {
        auth: vi.fn(async () => true), activeSession: vi.fn(() => true), queue: vi.fn(async (fn: Function) => fn()),
        prepare: vi.fn(async () => ({ modules: [{ id: 'mod' }] })), assets, kv, recordTransition: vi.fn(),
    }
    registerModuleAssetRoutes({ get: (path: string, handler: Function) => routes[`GET ${path}`] = handler,
        post: (path: string, handler: Function) => routes[`POST ${path}`] = handler }, deps)
    const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })
    const post = async (body: unknown) => { const response = res(); await routes['POST /api/module-assets/transition']({ body }, response); return response }
    return { deps, assets, kv, routes, res, post }
}

it('merges retired counts into the overview for characters and modules', async () => {
    const { routes, res } = fixture()
    const response = res()
    await routes['GET /api/storage-packages/overview']({}, response)
    expect(response.json).toHaveBeenCalledWith({
        characters: { one: { package: true, assets: true, retired: 4 } },
        modules: { mod: { enabled: true, copied: 2, failed: 0, retired: 1 }, gone: { enabled: false, copied: 0, failed: 0, retired: 2 } },
    })
})

it('copies module assets and retires only after the folder exists', async () => {
    const { deps, assets, kv, post } = fixture()
    let queued = false
    deps.queue.mockImplementation(async (fn: Function) => { queued = true; try { return await fn() } finally { queued = false } })
    assets.copyModule.mockImplementation(async () => { expect(queued).toBe(false); return { copied: 2 } })
    await post({ moduleId: 'mod', action: 'migrate' })
    expect(assets.prepareModuleCopy).toHaveBeenCalledWith({ modules: [{ id: 'mod' }] }, 'mod')
    expect(assets.publishModuleCopy).toHaveBeenCalledWith({ id: 'mod' }, { copied: 2 })
    expect(assets.releaseModuleCopy).toHaveBeenCalledWith({ id: 'mod' })
    expect(deps.queue).toHaveBeenCalledTimes(2)
    deps.queue.mockClear()
    assets.verifyModuleRetirement.mockImplementation(async () => { expect(queued).toBe(false); return { candidates: [{ key: 'assets/a.png', object: 'a', size: 1 }], shared: 3, unverified: 0 } })
    const retired = await post({ moduleId: 'mod', action: 'retire-kv' })
    expect(deps.queue).toHaveBeenCalledTimes(2)
    expect(kv.retireAssets).toHaveBeenCalledWith('module:mod', [{ key: 'assets/a.png', object: 'a', size: 1 }])
    expect(retired.json).toHaveBeenCalledWith(expect.objectContaining({ v4: { retired: 1, shared: 3, unverified: 0 } }))
    assets.moduleStatus.mockReturnValue({ enabled: false, directory: '', copied: 0, failed: 0 })
    const refused = await post({ moduleId: 'mod', action: 'retire-kv' })
    expect(refused.status).toHaveBeenCalledWith(409)
})

it('restores retired assets before disabling folder reads and refuses on restore failure', async () => {
    const { deps, assets, kv, post } = fixture()
    deps.prepare.mockResolvedValue(null)
    await post({ moduleId: 'mod', action: 'disable' })
    expect(kv.restoreRetiredAssets.mock.invocationCallOrder[0]).toBeLessThan(assets.disableModule.mock.invocationCallOrder[0])
    kv.restoreRetiredAssets.mockReturnValue({ restored: 0, failed: 1 })
    assets.disableModule.mockClear()
    const failed = await post({ moduleId: 'mod', action: 'disable' })
    expect(assets.disableModule).not.toHaveBeenCalled()
    expect(failed.status).toHaveBeenCalledWith(500)
})

it('validates IDs, writer ownership and module existence', async () => {
    const { deps, post } = fixture()
    expect((await post({ moduleId: '../x', action: 'migrate' })).status).toHaveBeenCalledWith(400)
    deps.prepare.mockResolvedValue({ modules: [] })
    expect((await post({ moduleId: 'mod', action: 'migrate' })).status).toHaveBeenCalledWith(404)
    deps.activeSession.mockReturnValue(false)
    await post({ moduleId: 'mod', action: 'migrate' })
    expect(deps.queue).toHaveBeenCalledTimes(1)
})

it('reports a running copy as a conflict without copying', async () => {
    const { assets, post } = fixture()
    assets.prepareModuleCopy.mockImplementation(() => { throw Object.assign(new Error('running'), { code: 'MODULE_COPY_RUNNING' }) })
    const response = await post({ moduleId: 'mod', action: 'migrate' })
    expect(response.status).toHaveBeenCalledWith(409)
    expect(assets.copyModule).not.toHaveBeenCalled()
    expect(assets.releaseModuleCopy).toHaveBeenCalledWith(null)
})
