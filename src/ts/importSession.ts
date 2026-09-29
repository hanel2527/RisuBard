import { language } from 'src/lang'
import { get, writable } from 'svelte/store'
import { alertWait, notifySuccess } from './alert'
import { forageStorage, requestImmediateSave, saveAsset } from './globalApi.svelte'
import { getDatabase } from './storage/database.svelte'
import { ImportCancelled, ImportTransaction, type ImportJournal, type ImportOwner } from './storage/importTransaction'
import { startImportProgress, stopImportProgress, beginImportSave, receiveImportProgress, loseImportProgress } from './importProgress'

const JOURNAL_KEY = 'risubard-pending-import-v1'
export const importSession = writable<{ phase: 'idle' | 'installing' | 'rolling-back' | 'recovery', error?: string }>({ phase: 'idle' })
let active: ImportTransaction | undefined

async function removeOwners(owners: ImportOwner[]) {
    if (!owners.length) return
    const db = getDatabase()
    const characters = new Set(owners.filter(o => o.type === 'character').map(o => o.id))
    const modules = new Set(owners.filter(o => o.type === 'module').map(o => o.id))
    db.characters = db.characters.filter(c => !characters.has(c.chaId))
    db.modules = db.modules.filter(m => !modules.has(m.id))
    db.characterOrder = (db.characterOrder ?? []).flatMap<(typeof db.characterOrder)[number]>(entry => typeof entry === 'string'
        ? characters.has(entry) ? [] : [entry]
        : [{ ...entry, data: entry.data.filter(id => !characters.has(id)) }])
    if (db.characterVault?.quickAccess) db.characterVault.quickAccess = db.characterVault.quickAccess
        .filter(s => s.kind !== 'character' || !characters.has(s.id))
    beginImportSave()
    await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true })
}

function dependencies() {
    return {
        write: (entries: Parameters<ImportTransaction['write']>[0]) => forageStorage.setItems(entries),
        journal: (record: ImportJournal | null) => record
            ? localStorage.setItem(JOURNAL_KEY, JSON.stringify(record)) : localStorage.removeItem(JOURNAL_KEY),
        removeOwners,
        prepareRollback: (id: string) => forageStorage.prepareImportRollback(id),
        cleanup: (keys: string[], id: string) => forageStorage.cleanupImportAssets(keys, id),
    }
}

export function checkImportRecovery() {
    if (!active && localStorage.getItem(JOURNAL_KEY)) importSession.set({ phase: 'recovery' })
}

export function cancelImport() {
    active?.cancel()
    importSession.set({ phase: 'rolling-back' })
    alertWait(language.importInstall.rollbackMessage)
}

export async function retryImportRollback() {
    if (get(importSession).phase !== 'recovery') return
    importSession.set({ phase: 'rolling-back' })
    startImportProgress()
    let stopWatching: (() => void) | undefined
    try {
        const record = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? 'null') as ImportJournal | null
        if (!record) throw new Error(language.importInstall.missingRecord)
        stopWatching = await forageStorage.observeImportProgress(record.id, receiveImportProgress, loseImportProgress)
        beginImportSave()
        await new ImportTransaction(new Set(), dependencies(), record).rollback()
        active = undefined
        importSession.set({ phase: 'idle' })
        notifySuccess(language.importInstall.cancelled)
    } catch (error) {
        importSession.set({ phase: 'recovery', error: String(error) })
    } finally {
        stopWatching?.()
        stopImportProgress()
    }
}

export async function runImport<T>(work: (transaction: ImportTransaction) => Promise<T>): Promise<T | null> {
    if (active || localStorage.getItem(JOURNAL_KEY)) {
        checkImportRecovery()
        throw new Error(language.importInstall.busy)
    }
    importSession.set({ phase: 'installing' })
    startImportProgress()
    alertWait(language.importInstall.preparing)
    // Claim the session before any async operation so two file imports cannot overlap.
    active = new ImportTransaction(new Set(), dependencies())
    let transaction = active
    let stopWatching: (() => void) | undefined
    try {
        const existing = await forageStorage.keys('assets/')
        transaction.check()
        active = transaction = new ImportTransaction(new Set(existing), dependencies())
        stopWatching = await forageStorage.observeImportProgress(transaction.id, receiveImportProgress, loseImportProgress)
        const result = await work(transaction)
        transaction.check()
        // Wait for all canonical data to reach the server before forgetting recovery.
        beginImportSave()
        alertWait(language.importInstall.saving)
        await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true })
        transaction.commit()
        active = undefined
        importSession.set({ phase: 'idle' })
        notifySuccess(language.importInstall.complete)
        return result
    } catch (error) {
        const wasCancelled = transaction.cancelled || error instanceof ImportCancelled
        importSession.set({ phase: 'rolling-back' })
        beginImportSave()
        alertWait(language.importInstall.rollbackMessage)
        try {
            await transaction.rollback()
            active = undefined
            importSession.set({ phase: 'idle' })
        } catch (rollbackError) {
            // Keep the write-ahead record. The retry button survives a page reload.
            importSession.set({ phase: 'recovery', error: String(rollbackError) })
            return null
        }
        if (wasCancelled) {
            notifySuccess(language.importInstall.cancelled)
            return null
        }
        throw error
    } finally {
        stopWatching?.()
        stopImportProgress()
    }
}

export function importAsset(transaction?: ImportTransaction) {
    return (data: Uint8Array, customId = '', fileName = '') => saveAsset(data, customId, fileName, transaction)
}
