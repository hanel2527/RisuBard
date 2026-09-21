import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startWithBranding } from './startupScreen'

describe('first startup screen', () => {
    beforeEach(() => {
        document.documentElement.lang = 'ko'
        document.body.innerHTML = '<img data-startup-logo="preloader"><span id="preloading-status"></span><p id="preloading-error" hidden></p>'
    })

    it('decodes the banner before loading the app and reports the real stage', async () => {
        let finishDecode!: () => void
        const logo = document.querySelector('img')!
        logo.decode = () => new Promise<void>(resolve => { finishDecode = resolve })
        const loadApp = vi.fn(async () => {
            expect(document.getElementById('preloading-status')?.textContent).toContain('앱 코드')
        })
        const startup = startWithBranding(loadApp)
        expect(loadApp).not.toHaveBeenCalled()
        expect(document.getElementById('preloading-status')?.textContent).toContain('배너')
        finishDecode()
        await startup
        expect(loadApp).toHaveBeenCalledOnce()
    })

    it('continues if the banner fails and leaves module failures visible as text', async () => {
        document.querySelector('img')!.decode = async () => { throw new Error('Image unavailable') }
        await startWithBranding(async () => { throw new Error('<failed chunk>') })
        expect(document.getElementById('preloading-status')?.textContent).toContain('앱 코드')
        const error = document.getElementById('preloading-error')!
        expect(error.hidden).toBe(false)
        expect(error.textContent).toContain('<failed chunk>')
        expect(error.children).toHaveLength(0)
    })
})
