import type { ModelPreset } from '../types'

export const OLLAMA_CLOUD_MAX_IN_FLIGHT = 3

export type RequestSlotRelease = () => void

interface QueuedRequest {
    signal?: AbortSignal
    resolve: (release: RequestSlotRelease) => void
    reject: (reason: unknown) => void
    settled: boolean
    removeAbortListener?: () => void
}

function abortReason(signal?: AbortSignal): unknown {
    return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * FIFO concurrency gate for requests billed by one Ollama Cloud service.
 *
 * The slot is intentionally independent of a fetch promise: callers keep it
 * until the response body has reached its terminal state (including streams).
 * The release function is idempotent so transport finally blocks can perform
 * normal cleanup after success, error, or an aborted fetch.
 */
export class OllamaCloudRequestLimiter {
    private active = 0
    private readonly queue: QueuedRequest[] = []

    get activeCount(): number {
        return this.active
    }

    get queuedCount(): number {
        return this.queue.filter((request) => !request.settled).length
    }

    acquire(signal?: AbortSignal): Promise<RequestSlotRelease> {
        if (signal?.aborted) {
            return Promise.reject(abortReason(signal))
        }
        if (this.active < OLLAMA_CLOUD_MAX_IN_FLIGHT && this.queue.length === 0) {
            return Promise.resolve(this.start())
        }

        let resolveDeferred!: (release: RequestSlotRelease) => void
        let rejectDeferred!: (reason: unknown) => void
        const promise = new Promise<RequestSlotRelease>((resolve, reject) => {
            resolveDeferred = resolve
            rejectDeferred = reject
        })
        const request: QueuedRequest = {
            signal,
            resolve: resolveDeferred,
            reject: rejectDeferred,
            settled: false,
        }
        const onAbort = () => {
            if (request.settled) return
            request.settled = true
            request.removeAbortListener?.()
            rejectDeferred(abortReason(signal))
            this.drain()
        }
        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true })
            request.removeAbortListener = () => signal.removeEventListener('abort', onAbort)
        }
        this.queue.push(request)
        this.drain()
        return promise
    }

    private start(): RequestSlotRelease {
        this.active++
        let released = false
        return () => {
            if (released) return
            released = true
            this.active--
            this.drain()
        }
    }

    private drain(): void {
        while (this.active < OLLAMA_CLOUD_MAX_IN_FLIGHT && this.queue.length > 0) {
            const request = this.queue.shift()!
            if (request.settled) continue
            if (request.signal?.aborted) {
                request.settled = true
                request.removeAbortListener?.()
                request.reject(abortReason(request.signal))
                continue
            }
            request.settled = true
            request.removeAbortListener?.()
            request.resolve(this.start())
        }
    }
}

export const ollamaCloudRequestLimiter = new OllamaCloudRequestLimiter()

export function isOllamaCloudEndpoint(url: string | undefined): boolean {
    if (!url) return false
    try {
        const hostname = new URL(url).hostname.toLowerCase()
        return hostname === 'ollama.com' || hostname.endsWith('.ollama.com')
    }
    catch {
        return false
    }
}

/**
 * The bundled provider id is authoritative. The prepared URL check also covers
 * a user-created OpenAI-compatible profile pointed at Ollama Cloud, including
 * Ollama-hosted Gemma profiles that do not carry the bundled provider id.
 */
export function isOllamaCloudRequest(preset: ModelPreset, preparedUrl: string): boolean {
    return preset.profileSnapshot.providerBaseId === 'ollama-cloud'
        || isOllamaCloudEndpoint(preparedUrl)
}
