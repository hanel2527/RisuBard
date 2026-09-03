import { afterEach, describe, expect, test, vi } from 'vitest'
import { SandboxHost } from './factory'

describe('API v3 plugin sandbox document', () => {
    afterEach(() => {
        document.body.replaceChildren()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    test('loads the sandbox from a blob URL and revokes it after load', async () => {
        const createObjectURL = vi.spyOn(URL, 'createObjectURL')
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL')
        const iframe = document.createElement('iframe')
        const host = new SandboxHost({})

        const stop = host.run(iframe, 'globalThis.pluginLoaded = true')
        const documentBlob = createObjectURL.mock.calls[0][0] as Blob

        expect(createObjectURL).toHaveBeenCalledOnce()
        expect(documentBlob).toBeInstanceOf(Blob)
        await expect(documentBlob.text()).resolves.toContain(
            'globalThis.pluginLoaded = true'
        )
        expect(iframe.src).toMatch(/^blob:/)
        expect(iframe.srcdoc).toBe('')
        expect(iframe.sandbox.contains('allow-scripts')).toBe(true)
        expect(iframe.sandbox.contains('allow-modals')).toBe(true)
        expect(iframe.sandbox.contains('allow-downloads')).toBe(true)
        expect(iframe.getAttribute('allow') ?? '').toContain('screen-wake-lock')
        expect(iframe.getAttribute('csp')).toContain("default-src 'none'")
        expect(revokeObjectURL).not.toHaveBeenCalled()

        iframe.dispatchEvent(new Event('load'))

        expect(revokeObjectURL).toHaveBeenCalledOnce()
        expect(revokeObjectURL).toHaveBeenCalledWith(
            createObjectURL.mock.results[0].value
        )

        stop()

        expect(revokeObjectURL).toHaveBeenCalledOnce()
    })

    test('revokes once when terminated before the document loads', () => {
        const createObjectURL = vi.spyOn(URL, 'createObjectURL')
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL')
        const iframe = document.createElement('iframe')
        const host = new SandboxHost({})

        host.run(iframe, '')
        host.terminate()
        iframe.dispatchEvent(new Event('load'))

        expect(revokeObjectURL).toHaveBeenCalledOnce()
        expect(revokeObjectURL).toHaveBeenCalledWith(
            createObjectURL.mock.results[0].value
        )
    })

    test('bridges callbacks nested in API argument objects', async () => {
        vi.stubGlobal('ImageBitmap', class ImageBitmap {})
        const addProvider = vi.fn()
        const iframe = document.createElement('iframe')
        const host = new SandboxHost({ addProvider })
        const stop = host.run(iframe, '')

        window.dispatchEvent(new MessageEvent('message', {
            source: iframe.contentWindow,
            data: {
                type: 'CALL_ROOT',
                reqId: 'add-provider',
                method: 'addProvider',
                args: [
                    'callback-repro',
                    { __type: 'CALLBACK_REF', id: 'provider-callback' },
                    {
                        overrideRequestStatus: {
                            __type: 'CALLBACK_REF',
                            id: 'status-callback',
                        },
                    },
                ],
            },
        }))

        await vi.waitFor(() => expect(addProvider).toHaveBeenCalledOnce())
        const [, provider, options] = addProvider.mock.calls[0]

        expect(provider).toBeTypeOf('function')
        expect(options.overrideRequestStatus).toBeTypeOf('function')

        stop()
    })

    test('serializes callbacks nested in guest API argument objects', async () => {
        const createObjectURL = vi.spyOn(URL, 'createObjectURL')
        const iframe = document.createElement('iframe')
        const host = new SandboxHost({})

        const stop = host.run(iframe, '')
        const documentBlob = createObjectURL.mock.calls[0][0] as Blob

        const documentText = await documentBlob.text()
        expect(documentText).toContain('const serialized = serializeArg(val);')
        expect(documentText).toContain('out[key] = serialized;')

        stop()
    })
})
