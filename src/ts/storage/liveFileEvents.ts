export interface LiveFileEvent {
    enabled: boolean
    defaultEnabled: boolean
    reason: 'ready' | 'change' | 'settings' | 'verify'
}

export function subscribeLiveFileEvents(options: {
    authenticate(): Promise<void>
    onEvent(event: LiveFileEvent): void
    onFallback(): void
}): () => void {
    let disposed = false
    let connected = false
    let connecting = false
    let disconnectedAt = Date.now()
    let source: EventSource | null = null
    const onMessage = (message: Event) => {
        if (disposed) return
        let event: LiveFileEvent
        try { event = JSON.parse((message as MessageEvent).data) } catch { return }
        if (typeof event.enabled !== 'boolean' || typeof event.defaultEnabled !== 'boolean'
            || !['ready', 'change', 'settings', 'verify'].includes(event.reason)) return
        connected = true
        options.onEvent(event)
    }
    const onError = () => {
        if (connected) disconnectedAt = Date.now()
        connected = false
    }
    const closeSource = () => {
        source?.removeEventListener('live-files', onMessage)
        source?.removeEventListener('error', onError)
        source?.close()
        source = null
    }
    async function connect(initial = false) {
        if (disposed || connecting) return
        if (typeof EventSource === 'undefined') {
            if (initial) options.onFallback()
            return
        }
        connecting = true
        closeSource()
        try {
            await options.authenticate()
            if (!disposed) {
                source = new EventSource('/api/live-files/events')
                source.addEventListener('live-files', onMessage)
                source.addEventListener('error', onError)
            }
        } catch {
            if (initial && !disposed) options.onFallback()
        } finally {
            connecting = false
        }
    }
    // Connected streams deliver their own verification signals. This timer only
    // recovers missing SSE support, expired cookies, or long disconnections.
    const fallback = setInterval(() => {
        if (disposed || connected || Date.now() - disconnectedAt < 60_000) return
        options.onFallback()
        void connect()
    }, 60_000)
    void connect(true)
    return () => {
        disposed = true
        clearInterval(fallback)
        closeSource()
    }
}
