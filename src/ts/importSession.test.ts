import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'

const mocks = vi.hoisted(() => ({
    cleanup: vi.fn(), prepare: vi.fn(), save: vi.fn(), success: vi.fn(),
    database: { characters: [] as any[], modules: [] as any[] },
}))
vi.mock('src/lang', () => ({ language: { importInstall: {
    busy: 'pending rollback', missingRecord: 'missing record', cancelled: 'cancelled',
} } }))
vi.mock('./stores.svelte', () => ({ alertStore: writable({ type: 'none', msg: '' }) }))
vi.mock('./alert', () => ({ alertWait: vi.fn(), notifySuccess: mocks.success }))
vi.mock('./globalApi.svelte', () => ({
    forageStorage: {
        keys: vi.fn(async () => []), setItems: vi.fn(async () => {}),
        cleanupImportAssets: mocks.cleanup, prepareImportRollback: mocks.prepare,
        observeImportProgress: vi.fn(async () => () => {}),
    },
    requestImmediateSave: mocks.save, saveAsset: vi.fn(),
}))
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => mocks.database }))
vi.mock('./importProgress', () => ({
    startImportProgress: vi.fn(), stopImportProgress: vi.fn(), beginImportSave: vi.fn(),
    receiveImportProgress: vi.fn(), loseImportProgress: vi.fn(),
}))

import * as session from './importSession'
import { alertStore } from './stores.svelte'

const key = 'risubard-pending-import-v1'
const record = { id: '12345678-1234-1234-1234-123456789abc', assets: ['assets/new.png'], owners: [] }

beforeEach(() => {
    vi.clearAllMocks()
    mocks.cleanup.mockReset().mockResolvedValue({ ok: true })
    mocks.save.mockReset().mockResolvedValue(undefined)
    mocks.database.characters = []
    mocks.database.modules = []
    localStorage.clear()
    session.importSession.set({ phase: 'idle' })
    alertStore.set({ type: 'none', msg: '' })
})

afterEach(() => vi.unstubAllGlobals())

it('resets only recorded installation owners and preserves the request when saving fails', async () => {
    const resetKey = 'risubard-reset-import-v1'
    localStorage.setItem(key, JSON.stringify({ ...record, owners: [{ type: 'character', id: 'new' }, { type: 'module', id: 'new-module' }] }))
    localStorage.setItem(resetKey, record.id)
    mocks.database.characters = [{ chaId: 'existing', chats: [{ message: ['keep'] }] }, { chaId: 'new' }]
    mocks.database.modules = [{ id: 'existing-module' }, { id: 'new-module' }]
    session.importSession.set({ phase: 'recovery' })
    mocks.save.mockRejectedValueOnce(new Error('offline'))
    await session.retryImportRollback()
    expect(get(session.importSession)).toMatchObject({ phase: 'recovery', error: 'Error: offline' })
    expect(localStorage.getItem(resetKey)).toBe(record.id)
    expect(localStorage.getItem(key)).not.toBeNull()
    expect(mocks.cleanup).not.toHaveBeenCalled()
    await session.retryImportRollback()
    expect(mocks.database.characters).toEqual([{ chaId: 'existing', chats: [{ message: ['keep'] }] }])
    expect(mocks.database.modules).toEqual([{ id: 'existing-module' }])
    expect(mocks.cleanup).toHaveBeenLastCalledWith(record.assets, record.id, true)
    expect(localStorage.getItem(key)).toBeNull()
    expect(localStorage.getItem(resetKey)).toBeNull()
    expect(get(session.importSession).phase).toBe('idle')
    await session.runImport(async () => {})
    expect(get(session.importSession).phase).toBe('idle')
})

it('persists a reset request and protects its journal from a late rollback response before reload', async () => {
    vi.resetModules()
    const isolated = await import('./importSession')
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    localStorage.setItem(key, JSON.stringify(record))
    isolated.importSession.set({ phase: 'recovery' })
    let finish!: (value: unknown) => void
    mocks.cleanup.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = isolated.retryImportRollback()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    isolated.requestImportReset()
    expect(reload).toHaveBeenCalledOnce()
    expect(localStorage.getItem('risubard-reset-import-v1')).toBe(record.id)
    finish({ ok: true })
    await pending
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(record)
    expect(localStorage.getItem('risubard-reset-import-v1')).toBe(record.id)
})

it('does not start a second recovery while reset is already running', async () => {
    localStorage.setItem(key, JSON.stringify(record))
    localStorage.setItem('risubard-reset-import-v1', record.id)
    session.importSession.set({ phase: 'recovery' })
    let finish!: (value: unknown) => void
    mocks.cleanup.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = session.retryImportRollback()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    session.checkImportRecovery()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(get(session.importSession).phase).toBe('rolling-back')
    expect(mocks.cleanup).toHaveBeenCalledTimes(1)
    finish({ ok: true })
    await pending
})

it('dismisses a failed recovery without losing its journal, and reopens it before any new import', async () => {
    localStorage.setItem(key, JSON.stringify(record))
    session.checkImportRecovery()
    mocks.cleanup.mockRejectedValueOnce(new Error('Import rollback failed (500)'))
    await session.retryImportRollback()
    alertStore.set({ type: 'wait', msg: 'rolling back' })
    session.dismissImportRecovery()
    expect(get(session.importSession)).toMatchObject({ phase: 'recovery', dismissed: true, error: expect.stringContaining('500') })
    expect(get(alertStore).type).toBe('none')
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(record)
    const work = vi.fn()
    await expect(session.runImport(work)).rejects.toThrow('pending rollback')
    expect(work).not.toHaveBeenCalled()
    expect(get(session.importSession)).toMatchObject({ phase: 'recovery', dismissed: false })
    await session.retryImportRollback()
    expect(localStorage.getItem(key)).toBeNull()
    expect(get(session.importSession).phase).toBe('idle')
})

it('reopens a dismissed rollback after a failure during this page session', async () => {
    mocks.cleanup.mockRejectedValueOnce(new Error('offline'))
    await session.runImport(async tx => {
        await tx.write([{ key: 'assets/new.png', value: new Uint8Array([1]) }])
        throw new Error('interrupted import')
    })
    session.dismissImportRecovery()
    const work = vi.fn()
    await expect(session.runImport(work)).rejects.toThrow('pending rollback')
    expect(work).not.toHaveBeenCalled()
    expect(get(session.importSession)).toMatchObject({ phase: 'recovery', dismissed: false })
    await session.retryImportRollback()
    expect(localStorage.getItem(key)).toBeNull()
})

it('does not dismiss an active rollback or clear another dialog', () => {
    session.importSession.set({ phase: 'rolling-back' })
    session.dismissImportRecovery()
    expect(get(session.importSession).phase).toBe('rolling-back')
    session.importSession.set({ phase: 'recovery' })
    alertStore.set({ type: 'input', msg: 'keep' })
    session.dismissImportRecovery()
    expect(get(alertStore)).toMatchObject({ type: 'input', msg: 'keep' })
})
