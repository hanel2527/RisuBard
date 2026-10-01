import { beforeEach, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'

const mocks = vi.hoisted(() => ({
    cleanup: vi.fn(), prepare: vi.fn(), save: vi.fn(), success: vi.fn(),
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
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => ({ characters: [], modules: [] }) }))
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
    localStorage.clear()
    session.importSession.set({ phase: 'idle' })
    alertStore.set({ type: 'none', msg: '' })
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
