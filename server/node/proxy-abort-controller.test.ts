import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createProxyAbortController } from './proxy-abort-controller.cjs'

function createResponse() {
    const response = new EventEmitter() as EventEmitter & { writableFinished: boolean }
    response.writableFinished = false
    return response
}

describe('createProxyAbortController', () => {
    it('aborts an active pipeline when the client closes the response early', async () => {
        const request = new EventEmitter()
        const response = new Writable({ write(_chunk, _encoding, callback) { callback() } })
        const abort = createProxyAbortController({ request, response, timeoutMs: null })
        const source = new Readable({ read() {} })
        source.once('error', abort.markUpstreamFailure)
        const forwarding = pipeline(source, response, { signal: abort.signal })

        response.destroy()

        await expect(forwarding).rejects.toBeDefined()
        expect(abort.signal.aborted).toBe(true)
        expect(abort.clientDisconnected()).toBe(true)
        expect(abort.timedOut()).toBe(false)
    })

    it('keeps an upstream source failure distinct when pipeline closes the response', async () => {
        const request = new EventEmitter()
        const response = new Writable({ write(_chunk, _encoding, callback) { callback() } })
        const abort = createProxyAbortController({ request, response, timeoutMs: null })
        const upstreamFailure = new Error('upstream connection reset')
        const upstreamBody = new ReadableStream({
            start(controller) {
                queueMicrotask(() => controller.error(upstreamFailure))
            }
        })
        const source = Readable.fromWeb(upstreamBody)

        source.once('error', abort.markUpstreamFailure)

        await expect(pipeline(source, response, { signal: abort.signal })).rejects.toBe(upstreamFailure)

        expect(abort.signal.aborted).toBe(false)
        expect(abort.clientDisconnected()).toBe(false)
    })

    it('does not abort after a pipeline completes normally', async () => {
        const request = new EventEmitter()
        const response = new Writable({ write(_chunk, _encoding, callback) { callback() } })
        const abort = createProxyAbortController({ request, response, timeoutMs: null })

        await pipeline(Readable.from(['ok']), response, { signal: abort.signal })

        expect(response.writableFinished).toBe(true)
        expect(abort.signal.aborted).toBe(false)
        expect(abort.clientDisconnected()).toBe(false)
    })

    it('identifies a timeout separately from a client disconnect', () => {
        vi.useFakeTimers()
        const request = new EventEmitter()
        const response = createResponse()
        const abort = createProxyAbortController({ request, response, timeoutMs: 50 })

        vi.advanceTimersByTime(50)
        response.emit('close')

        expect(abort.signal.aborted).toBe(true)
        expect(abort.timedOut()).toBe(true)
        expect(abort.clientDisconnected()).toBe(false)
        abort.cleanup()
        vi.useRealTimers()
    })

    it('aborts immediately when the response was already destroyed before proxying begins', () => {
        const request = new EventEmitter()
        const response = createResponse() as EventEmitter & { writableFinished: boolean; destroyed: boolean }
        response.writableFinished = false
        response.destroyed = true

        const abort = createProxyAbortController({ request, response, timeoutMs: null })

        expect(abort.signal.aborted).toBe(true)
        expect(abort.clientDisconnected()).toBe(true)
    })
})
