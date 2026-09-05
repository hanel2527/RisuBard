import { vi } from 'vitest'

// Suppress warning
vi.mock(import('katex'), () => ({}))

vi.stubGlobal('safeStructuredClone', (v: unknown) => JSON.parse(JSON.stringify(v)))

// Keep unit tests hermetic. Individual tests can replace this with vi.stubGlobal().
globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string'
        ? input
        : input instanceof URL
            ? input.href
            : input.url
    const resolvedUrl = new URL(url, window.location.href)
    return Promise.reject(new Error(`Unmocked network request in Vitest: ${resolvedUrl.href}`))
}) as typeof fetch
