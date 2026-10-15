import { afterEach, describe, expect, it } from 'vitest'
import {
    PLUGIN_FRAME_BEHIND_DIALOG_Z_INDEX,
    PLUGIN_FULLSCREEN_Z_INDEX,
    registerFullscreenPluginFrame,
    unregisterFullscreenPluginFrame,
    withPluginFramesBehindDialog,
} from './pluginFrameLayer'

function fullscreenFrame() {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    registerFullscreenPluginFrame(frame)
    return frame
}

afterEach(() => document.body.replaceChildren())

describe('fullscreen plugin frame layering', () => {
    it('drops below app dialogs while a plugin waits on one and restores afterwards', async () => {
        const frame = fullscreenFrame()
        expect(frame.style.zIndex).toBe(PLUGIN_FULLSCREEN_Z_INDEX)
        let resolve!: (value: boolean) => void
        const answer = withPluginFramesBehindDialog(() =>
            new Promise<boolean>((done) => { resolve = done }))
        expect(frame.style.zIndex).toBe(PLUGIN_FRAME_BEHIND_DIALOG_Z_INDEX)
        resolve(true)
        await expect(answer).resolves.toBe(true)
        expect(frame.style.zIndex).toBe(PLUGIN_FULLSCREEN_Z_INDEX)
    })

    it('restores only after the last overlapping dialog closes, even on failure', async () => {
        const frame = fullscreenFrame()
        let closeFirst!: () => void
        const first = withPluginFramesBehindDialog(() =>
            new Promise<void>((done) => { closeFirst = done }))
        const second = withPluginFramesBehindDialog(async () => {
            throw new Error('dialog failed')
        })
        await expect(second).rejects.toThrow('dialog failed')
        expect(frame.style.zIndex).toBe(PLUGIN_FRAME_BEHIND_DIALOG_Z_INDEX)
        closeFirst()
        await first
        expect(frame.style.zIndex).toBe(PLUGIN_FULLSCREEN_Z_INDEX)
    })

    it('keeps a frame opened during a dialog behind it, and ignores hidden frames', async () => {
        let close!: () => void
        const dialog = withPluginFramesBehindDialog(() =>
            new Promise<void>((done) => { close = done }))
        const opened = fullscreenFrame()
        expect(opened.style.zIndex).toBe(PLUGIN_FRAME_BEHIND_DIALOG_Z_INDEX)
        const hidden = fullscreenFrame()
        unregisterFullscreenPluginFrame(hidden)
        close()
        await dialog
        expect(opened.style.zIndex).toBe(PLUGIN_FULLSCREEN_Z_INDEX)
        expect(hidden.style.zIndex).toBe(PLUGIN_FRAME_BEHIND_DIALOG_Z_INDEX)
    })
})
