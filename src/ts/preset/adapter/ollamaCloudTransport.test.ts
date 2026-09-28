import { describe, expect, test } from 'vitest'
import type { ModelPreset, ResolvedModelProfileSnapshot } from '../types'
import { sendChatRequest, streamChatRequest } from './openaiCompatible'
import type { AdapterChatMessage } from './types'

const messages: AdapterChatMessage[] = [{ role: 'user', content: 'hello' }]

function makeCloudPreset(endpoint = 'https://ollama.com/v1/chat/completions'): ModelPreset {
    const profileSnapshot: ResolvedModelProfileSnapshot = {
        profileId: 'custom:ollama-cloud',
        profileVersion: 1,
        providerBaseId: 'openai-compatible',
        providerBaseVersion: 1,
        adapterKind: 'openai-compatible',
        auth: { kind: 'bearer', fields: ['apiKey'] },
        endpoint: { kind: 'static', url: endpoint },
        modelId: 'gemma4:31b-cloud',
        schema: [
            {
                key: 'apiKey',
                type: 'string',
                label: 'API Key',
                secret: true,
                mapsTo: { target: 'auth', path: 'apiKey' },
            },
            {
                key: 'modelId',
                type: 'string',
                label: 'Model ID',
                default: 'gemma4:31b-cloud',
                mapsTo: { target: 'body', path: 'model' },
            },
        ],
        uiSchema: { groups: [], fields: [] },
        defaults: {},
        headerTemplate: { 'Content-Type': 'application/json' },
        capabilities: ['streaming'],
    }
    return {
        id: 'ollama-cloud-test',
        name: 'Ollama Cloud test',
        profileSnapshot,
        userValues: { modelId: 'gemma4:31b-cloud' },
        createdAt: 0,
        updatedAt: 0,
    }
}

function jsonResponse(content = 'ok'): Response {
    return new Response(JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
    }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    })
}
function deferred<T>(): {
    promise: Promise<T>
    resolve: (value?: T | PromiseLike<T>) => void
    reject: (reason?: unknown) => void
} {
    let resolve!: (value?: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}


interface PendingFetch {
    resolve: (response: Response) => void
    reject: (error: unknown) => void
}

function pendingFetch(): {
    fetchImpl: typeof fetch
    pending: PendingFetch[]
    getMaxActive: () => number
    waitForStarted: (count: number) => Promise<void>
} {
    const pending: PendingFetch[] = []
    const startWaiters: Array<{ count: number; resolve: () => void }> = []
    let active = 0
    let maxActive = 0
    const waitForStarted = (count: number): Promise<void> => {
        if (pending.length >= count) return Promise.resolve()
        const gate = deferred<void>()
        startWaiters.push({ count, resolve: () => gate.resolve() })
        return gate.promise
    }
    const fetchImpl: typeof fetch = async (_input, init) => {
        active++
        maxActive = Math.max(maxActive, active)
        try {
            const gate = deferred<Response>()
            const signal = init?.signal
            const abort = () => gate.reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
            if (signal) signal.addEventListener('abort', abort, { once: true })
            const cleanup = () => signal?.removeEventListener('abort', abort)
            pending.push({
                resolve: (response) => {
                    cleanup()
                    gate.resolve(response)
                },
                reject: (error) => {
                    cleanup()
                    gate.reject(error)
                },
            })
            for (let index = startWaiters.length - 1; index >= 0; index--) {
                if (pending.length < startWaiters[index].count) continue
                startWaiters[index].resolve()
                startWaiters.splice(index, 1)
            }
            return await gate.promise
        }
        finally {
            active--
        }
    }
    return { fetchImpl, pending, getMaxActive: () => maxActive, waitForStarted }
}

describe('Ollama Cloud transport limiter', () => {
    test('limits custom profiles targeting Ollama Cloud to three requests in flight', async () => {
        const { fetchImpl, pending, getMaxActive, waitForStarted } = pendingFetch()
        const preset = makeCloudPreset()
        const requests = Array.from({ length: 4 }, () => sendChatRequest(
            preset,
            { messages, fetchImpl },
            { apiKey: 'key' },
        ))

        await waitForStarted(3)
        expect(getMaxActive()).toBe(3)
        pending[0].resolve(jsonResponse())
        await waitForStarted(4)
        expect(getMaxActive()).toBe(3)

        for (const request of pending.slice(1)) request.resolve(jsonResponse())
        await Promise.all(requests)
    })

    test('releases a slot after a failed request and after abort', async () => {
        const { fetchImpl, pending, waitForStarted } = pendingFetch()
        const preset = makeCloudPreset()
        const controller = new AbortController()
        const requests = [
            sendChatRequest(preset, { messages, fetchImpl }, { apiKey: 'key' }),
            sendChatRequest(preset, { messages, fetchImpl }, { apiKey: 'key' }),
            sendChatRequest(preset, { messages, fetchImpl }, { apiKey: 'key' }),
            sendChatRequest(preset, { messages, fetchImpl, abortSignal: controller.signal }, { apiKey: 'key' }),
            sendChatRequest(preset, { messages, fetchImpl }, { apiKey: 'key' }),
        ]

        await waitForStarted(3)
        pending[0].reject(new TypeError('connection reset'))
        await expect(requests[0]).rejects.toMatchObject({ kind: 'network' })
        await waitForStarted(4)

        controller.abort()
        await expect(requests[3]).rejects.toMatchObject({ kind: 'aborted' })
        await waitForStarted(5)
        for (const request of pending.slice(1, 3)) request.resolve(jsonResponse())
        pending[4].resolve(jsonResponse())
        await Promise.all([requests[1], requests[2], requests[4]])
    })

    test('holds a slot until a streamed response reaches terminal completion', async () => {
        const preset = makeCloudPreset()
        const encoder = new TextEncoder()
        const closers: Array<() => void> = []
        let calls = 0
        const fourthStarted = deferred<void>()
        const fetchImpl: typeof fetch = async () => {
            calls++
            if (calls === 4) fourthStarted.resolve()
            let close!: () => void
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'))
                    close = () => {
                        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                        controller.close()
                    }
                },
            })
            closers.push(close)
            return new Response(body, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
            })
        }

        const first = streamChatRequest(preset, { messages, fetchImpl }, { apiKey: 'key' })
        const second = streamChatRequest(preset, { messages, fetchImpl }, { apiKey: 'key' })
        const third = streamChatRequest(preset, { messages, fetchImpl }, { apiKey: 'key' })
        const fourth = streamChatRequest(preset, { messages, fetchImpl }, { apiKey: 'key' })
        await Promise.all([first.next(), second.next(), third.next()])
        const fourthFirst = fourth.next()
        expect(calls).toBe(3)

        closers[0]()
        await first.next()
        await fourthStarted.promise
        closers.slice(1).forEach((close) => close())
        await Promise.all([second.next(), third.next(), fourthFirst])
        await fourth.next()
    })
})
