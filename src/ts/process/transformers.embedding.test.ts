import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    pipeline: vi.fn(),
    env: {},
}))

vi.mock('@huggingface/transformers', () => ({
    pipeline: mocks.pipeline,
    env: mocks.env,
}))
vi.mock('src/ts/globalApi.svelte', () => ({
    loadAsset: vi.fn(),
    saveAsset: vi.fn(),
}))
vi.mock('src/ts/util', () => ({
    asBuffer: vi.fn(),
    selectSingleFile: vi.fn(),
}))

function extractor(vector = [1, 0]) {
    const run = vi.fn(async (texts: string[]) => ({
        data: new Float32Array(texts.length * vector.length).map((_, index) => vector[index % vector.length]),
    }))
    return Object.assign(run, { dispose: vi.fn(async () => undefined) })
}

async function loadRunEmbedding() {
    const module = await import('./transformers')
    return module.runEmbedding
}

beforeEach(() => {
    vi.resetModules()
    mocks.pipeline.mockReset()
    Object.assign(mocks.env, {})
    Object.defineProperty(globalThis, 'caches', {
        configurable: true,
        value: { open: vi.fn(async () => ({ put: vi.fn(), match: vi.fn() })) },
    })
})

describe('runEmbedding shared extractor', () => {
    test('serializes model replacement until the active inference completes', async () => {
        let releaseFirst!: () => void
        const first = Object.assign(vi.fn(async () => {
            await new Promise<void>(resolve => { releaseFirst = resolve })
            return { data: new Float32Array([1, 0]) }
        }), { dispose: vi.fn(async () => undefined) })
        const second = extractor([0, 1])
        mocks.pipeline.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
        const runEmbedding = await loadRunEmbedding()

        const active = runEmbedding(['first'], 'Xenova/all-MiniLM-L6-v2', 'wasm')
        await vi.waitFor(() => expect(first).toHaveBeenCalledOnce())
        const queued = runEmbedding(['second'], 'nomic-ai/nomic-embed-text-v1.5', 'wasm')
        expect(mocks.pipeline).toHaveBeenCalledTimes(1)

        releaseFirst()
        await expect(active).resolves.toHaveLength(1)
        await expect(queued).resolves.toHaveLength(1)
        expect(first.dispose).toHaveBeenCalledOnce()
        expect(mocks.pipeline).toHaveBeenCalledTimes(2)
    })

    test('does not reuse a disposed extractor after replacement load fails', async () => {
        const initial = extractor([1, 0])
        const replacement = extractor([0, 1])
        mocks.pipeline
            .mockResolvedValueOnce(initial)
            .mockRejectedValueOnce(new Error('model load failed'))
            .mockResolvedValueOnce(replacement)
        const runEmbedding = await loadRunEmbedding()

        await runEmbedding(['initial'], 'Xenova/all-MiniLM-L6-v2', 'wasm')
        await expect(runEmbedding(['replacement'], 'nomic-ai/nomic-embed-text-v1.5', 'wasm'))
            .rejects.toThrow('model load failed')
        await expect(runEmbedding(['retry'], 'Xenova/all-MiniLM-L6-v2', 'wasm')).resolves.toHaveLength(1)

        expect(initial.dispose).toHaveBeenCalledOnce()
        expect(mocks.pipeline).toHaveBeenCalledTimes(3)
        expect(initial).toHaveBeenCalledTimes(1)
    })

    test('abandons a cancelled request before it enters the shared queue', async () => {
        const controller = new AbortController()
        controller.abort(new DOMException('cancelled', 'AbortError'))
        const runEmbedding = await loadRunEmbedding()

        await expect(runEmbedding(['cancelled'], 'Xenova/all-MiniLM-L6-v2', 'wasm', controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' })
        expect(mocks.pipeline).not.toHaveBeenCalled()
    })
})
