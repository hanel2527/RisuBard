import { get, writable } from 'svelte/store'

export interface ServerImportEvent {
    type: 'progress' | 'heartbeat'
    stage?: string
    completed?: number
    total?: number
    detail?: string
}
export interface ImportProgressState {
    active: boolean
    startedAt: number
    activityAt: number
    contactAt: number
    server: boolean
    connection: 'connecting' | 'connected' | 'lost'
    message: string
    stage?: string
    detail?: string
    percent?: number
    completed?: number
    total?: number
}
const empty = (): ImportProgressState => ({ active: false, startedAt: 0, activityAt: 0, contactAt: 0, server: false, connection: 'connecting', message: '' })
export const importProgress = writable<ImportProgressState>(empty())
export function startImportProgress() {
    const now = Date.now()
    importProgress.set({ ...empty(), active: true, startedAt: now, activityAt: now })
}
export function stopImportProgress() { importProgress.update(p => ({ ...p, active: false })) }
export function noteImportActivity(message: string, percent?: number) {
    const p = get(importProgress)
    if (!p.active || p.server) return
    importProgress.set({ ...p, message, percent: Number.isFinite(percent) ? percent : undefined, activityAt: Date.now() })
}
export function beginImportSave() {
    importProgress.update(p => ({ ...p, server: true, stage: 'waiting-save', percent: undefined, detail: undefined, completed: undefined, total: undefined, activityAt: Date.now() }))
}
export function receiveImportProgress(event: ServerImportEvent) {
    const p = get(importProgress)
    if (!p.active) return
    const now = Date.now()
    if (event.type === 'heartbeat') {
        // Connectivity is not evidence of work progressing.
        importProgress.set({ ...p, connection: 'connected', contactAt: now })
        return
    }
    if (!p.server) return
    const total = event.total && event.total > 0 ? event.total : undefined
    const completed = Number.isFinite(event.completed) ? event.completed : undefined
    importProgress.set({ ...p, connection: 'connected', contactAt: now, activityAt: now,
        stage: event.stage, detail: event.detail, total, completed,
        percent: total && completed !== undefined ? Math.max(0, Math.min(100, completed / total * 100)) : undefined })
}
export function loseImportProgress() {
    importProgress.update(p => ({ ...p, connection: 'lost' }))
}
