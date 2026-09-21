import { describe, expect, it, vi } from 'vitest'
import { advanceStartupStage, failStartupStage } from './startupProgress'

describe('startup progress', () => {
    it('publishes the next stage before yielding to let the screen update', async () => {
        vi.useFakeTimers()
        try {
            const state = { text: 'Previous step', error: '' }
            let started = false
            const work = advanceStartupStage(state, 'Reading save').then(() => { started = true })
            expect(state.text).toBe('Reading save')
            expect(started).toBe(false)
            await vi.runAllTimersAsync()
            await work
            expect(started).toBe(true)
        } finally { vi.useRealTimers() }
    })

    it('retains the failed stage and displays the error without swallowing it', () => {
        const state = { text: 'Reading save', error: '' }
        failStartupStage(state, new Error('Connection closed'))
        expect(state).toEqual({ text: 'Reading save', error: 'Connection closed' })
    })
})
