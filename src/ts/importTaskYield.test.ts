import { afterEach, describe, expect, test, vi } from 'vitest'
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads'
import { yieldImportTask } from './importTaskYield'

class TestPort {
    onmessage: ((event: MessageEvent) => void) | null = null
    peer?: TestPort
    closed = false

    postMessage() {
        setImmediate(() => this.peer?.onmessage?.(new MessageEvent('message')))
    }

    close() {
        this.closed = true
    }
}

class TestMessageChannel {
    static channels: TestMessageChannel[] = []
    port1 = new TestPort()
    port2 = new TestPort()

    constructor() {
        this.port1.peer = this.port2
        this.port2.peer = this.port1
        TestMessageChannel.channels.push(this)
    }
}

const originalMessageChannel = globalThis.MessageChannel

afterEach(() => {
    globalThis.MessageChannel = originalMessageChannel
    TestMessageChannel.channels = []
    vi.restoreAllMocks()
})

describe('yieldImportTask', () => {
    test('uses a real MessageChannel task turn when timers and animation frames cannot run', async () => {
        globalThis.MessageChannel = NodeMessageChannel as unknown as typeof MessageChannel
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as never)
        vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 0)

        const turns: string[] = []
        const yielded = yieldImportTask().then(() => turns.push('task'))
        turns.push('sync')
        await Promise.resolve().then(() => turns.push('microtask'))

        expect(turns).toEqual(['sync', 'microtask'])
        await yielded
        expect(turns).toEqual(['sync', 'microtask', 'task'])
    })

    test('closes both ports for concurrent task yields', async () => {
        globalThis.MessageChannel = TestMessageChannel as unknown as typeof MessageChannel

        await Promise.all([yieldImportTask(), yieldImportTask(), yieldImportTask()])

        expect(TestMessageChannel.channels).toHaveLength(3)
        for (const channel of TestMessageChannel.channels) {
            expect(channel.port1.closed).toBe(true)
            expect(channel.port2.closed).toBe(true)
        }
    })
})
