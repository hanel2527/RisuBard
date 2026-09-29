import { describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { importProgress, startImportProgress, noteImportActivity, beginImportSave, receiveImportProgress, stopImportProgress } from './importProgress'

describe('honest import progress', () => {
    it('clears the asset phase 100% when durable server saving begins', () => {
        startImportProgress()
        noteImportActivity('assets', 100)
        beginImportSave()
        expect(get(importProgress)).toMatchObject({ server: true, stage: 'waiting-save', percent: undefined })
    })
    it('uses real operation counts and does not turn heartbeats into progress', () => {
        vi.spyOn(Date, 'now').mockReturnValue(100)
        startImportProgress(); beginImportSave()
        receiveImportProgress({ type: 'progress', stage: 'publish-files', completed: 50, total: 200 })
        vi.mocked(Date.now).mockReturnValue(5000)
        receiveImportProgress({ type: 'heartbeat' })
        expect(get(importProgress)).toMatchObject({ percent: 25, activityAt: 100, contactAt: 5000 })
        receiveImportProgress({ type: 'progress', stage: 'verify-save' })
        expect(get(importProgress).percent).toBeUndefined()
        stopImportProgress()
        receiveImportProgress({ type: 'progress', stage: 'late-event' })
        expect(get(importProgress).stage).toBe('verify-save')
        vi.restoreAllMocks()
    })
})
