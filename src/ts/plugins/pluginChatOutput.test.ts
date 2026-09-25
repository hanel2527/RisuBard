import { describe, expect, test, vi } from 'vitest'
import {
    PluginChatOutputListeners,
    V2_CHAT_OUTPUT_OWNER,
    createV2ChatOutputApi,
    dispatchCommittedChatOutput,
    readInlayWithPermission,
} from './pluginChatOutput'

describe('plugin chat output listeners', () => {
    const output = {
        char: { name: 'Ari', tags: ['host'] },
        chat: { message: [{ chatId: 'reply-1', data: 'Hello' }] },
        characterIndex: 2,
        chatIndex: 3,
        messageIndex: 0,
    }

    test('does not read an inlay when permission is denied', async () => {
        const read = vi.fn()

        await expect(readInlayWithPermission(async () => false, read)).resolves.toBeNull()
        expect(read).not.toHaveBeenCalled()
    })

    test('returns the inlay result after permission is granted, including not found', async () => {
        const asset = { name: 'map', data: 'data:image/png;base64,AA==' }
        const read = vi.fn().mockResolvedValueOnce(asset).mockResolvedValueOnce(null)

        await expect(readInlayWithPermission(async () => true, read)).resolves.toEqual(asset)
        await expect(readInlayWithPermission(async () => true, read)).resolves.toBeNull()
        expect(read).toHaveBeenCalledTimes(2)
    })

    test('does not serialize a cyclic output payload when no listeners exist', async () => {
        const listeners = new PluginChatOutputListeners()
        const cyclic: { self?: unknown } = {}
        cyclic.self = cyclic

        await expect(listeners.dispatch({
            ...output,
            char: cyclic,
        })).resolves.toBeUndefined()
    })

    test('dispatches a large-shaped payload when aggregate JSON serialization exceeds the host limit', async () => {
        const listeners = new PluginChatOutputListeners()
        const listener = vi.fn()
        const oversized = {
            ...output,
            chat: {
                message: Array.from({ length: 30 }, (_, index) => ({ chatId: `reply-${index}`, data: 'short record' })),
            },
        }
        const nativeStringify = JSON.stringify
        const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
            const serialized = nativeStringify(value, ...args)
            if (serialized.length > 100) {
                throw new RangeError('Invalid string length')
            }
            return serialized
        })
        listeners.add(V2_CHAT_OUTPUT_OWNER, listener)

        try {
            await expect(listeners.dispatch(oversized)).resolves.toBeUndefined()

            expect(listener).toHaveBeenCalledWith(oversized)
        }
        finally {
            stringify.mockRestore()
        }
    })

    test('matches JSON snapshots for proxy-backed values and JSON edge cases', async () => {
        const listeners = new PluginChatOutputListeners()
        const listener = vi.fn()
        const shared = { value: 'shared' }
        let toJSONCalls = 0
        const selfToJSON = {
            value: 'self',
            toJSON() {
                toJSONCalls++
                return this
            },
        }
        const proto = Object.create(null) as Record<string, unknown>
        Object.defineProperty(proto, '__proto__', {
            enumerable: true,
            value: { preserved: true },
        })
        const payload = new Proxy({
            ...output,
            char: {
                date: new Date('2026-09-24T12:00:00.000Z'),
                sparse: [, undefined, Number.NaN, -0],
                wrappedNumber: new Number(7),
                wrappedString: new String('wrapped'),
                wrappedBoolean: new Boolean(false),
                shared: [shared, shared],
                selfToJSON,
                proto,
                omitted: undefined,
            },
        }, {})
        const expected = JSON.parse(JSON.stringify(payload))
        toJSONCalls = 0
        listeners.add(V2_CHAT_OUTPUT_OWNER, listener)

        await listeners.dispatch(payload)

        expect(toJSONCalls).toBe(1)
        expect(listener).toHaveBeenCalledWith(expected)
        const snapshot = listener.mock.calls[0][0]
        expect(Object.hasOwn(snapshot.char.proto, '__proto__')).toBe(true)
        expect(Object.getPrototypeOf(snapshot.char.proto)).toBe(Object.prototype)
    })

    test('contains canonical snapshot failures so output processing can continue', async () => {
        const listeners = new PluginChatOutputListeners()
        const listener = vi.fn()
        const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const snapshotFailure = new RangeError('snapshot failed')
        const unreadable = new Proxy({}, {
            ownKeys() {
                throw snapshotFailure
            },
        })
        listeners.add(V2_CHAT_OUTPUT_OWNER, listener)

        try {
            await expect(listeners.dispatch({ ...output, char: unreadable })).resolves.toBeUndefined()

            expect(listener).not.toHaveBeenCalled()
            expect(logError).toHaveBeenCalledWith('Failed to snapshot plugin chat output:', snapshotFailure)
        }
        finally {
            logError.mockRestore()
        }
    })

    test('removes an owner-scoped chat listener and ignores duplicate registration', async () => {
        const listeners = new PluginChatOutputListeners()
        const listener = vi.fn()

        listeners.add(V2_CHAT_OUTPUT_OWNER, listener)
        listeners.add(V2_CHAT_OUTPUT_OWNER, listener)
        await listeners.dispatch(output)
        listeners.remove(V2_CHAT_OUTPUT_OWNER, listener)
        await listeners.dispatch(output)

        expect(listener).toHaveBeenCalledTimes(1)
    })

    test('uses one canonical event snapshot while isolating listener errors and mutations', async () => {
        const listeners = new PluginChatOutputListeners()
        const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const observer = vi.fn()
        let releaseFirstListener: (() => void) | undefined
        const firstListenerStarted = new Promise<void>((resolve) => {
            listeners.add('v3:one', async (snapshot) => {
                snapshot.char.name = 'mutated'
                snapshot.chat.message[0].data = 'mutated'
                resolve()
                await new Promise<void>((done) => { releaseFirstListener = done })
                throw new Error('listener failure')
            })
        })
        listeners.add('v3:two', observer)

        const dispatched = listeners.dispatch(output)
        await firstListenerStarted
        output.char.name = 'host changed while awaiting'
        output.chat.message[0].data = 'host changed while awaiting'
        releaseFirstListener?.()
        await dispatched

        expect(observer).toHaveBeenCalledWith({
            char: { name: 'Ari', tags: ['host'] },
            chat: { message: [{ chatId: 'reply-1', data: 'Hello' }] },
            characterIndex: 2,
            chatIndex: 3,
            messageIndex: 0,
        })
        expect(logError).toHaveBeenCalledOnce()
    })

    test('clears only the requested owner so V2 reload does not remove V3 listeners', async () => {
        const listeners = new PluginChatOutputListeners()
        const v2 = vi.fn()
        const v3 = vi.fn()
        listeners.add(V2_CHAT_OUTPUT_OWNER, v2)
        listeners.add('v3:plugin-a', v3)

        listeners.clear(V2_CHAT_OUTPUT_OWNER)
        await listeners.dispatch(output)

        expect(v2).not.toHaveBeenCalled()
        expect(v3).toHaveBeenCalledOnce()
    })

    test('does not let a V2 caller spoof a V3 owner to survive V2 reload cleanup', async () => {
        const listeners = new PluginChatOutputListeners()
        const listener = vi.fn()
        const v2Api = createV2ChatOutputApi(listeners)

        expect(v2Api.addRisuChatListener).toHaveLength(2)
        ;(v2Api.addRisuChatListener as (...args: any[]) => void)(
            'output',
            listener,
            'v3:spoofed-owner',
        )
        listeners.clear(V2_CHAT_OUTPUT_OWNER)
        await listeners.dispatch(output)

        expect(listener).not.toHaveBeenCalled()
    })

    test('V3-style owner cleanup releases every callback without retaining removed functions', async () => {
        const listeners = new PluginChatOutputListeners()
        const removed = vi.fn()
        const retained = vi.fn()
        listeners.add('v3:plugin-a', removed)
        listeners.add('v3:plugin-a', retained)
        listeners.remove('v3:plugin-a', removed)

        listeners.clear('v3:plugin-a')
        await listeners.dispatch(output)

        expect(removed).not.toHaveBeenCalled()
        expect(retained).not.toHaveBeenCalled()
        expect(listeners.size).toBe(0)
    })

    test('registers at most one unload cleanup per V3 owner across add and remove cycles', () => {
        const listeners = new PluginChatOutputListeners()
        const registerCleanup = vi.fn()
        const first = vi.fn()
        const second = vi.fn()

        listeners.add('v3:plugin-a', first)
        listeners.ensureOwnerCleanup('v3:plugin-a', registerCleanup)
        listeners.remove('v3:plugin-a', first)
        listeners.add('v3:plugin-a', second)
        listeners.ensureOwnerCleanup('v3:plugin-a', registerCleanup)

        expect(registerCleanup).toHaveBeenCalledOnce()
        const cleanup = registerCleanup.mock.calls[0][0] as () => void
        cleanup()
        expect(listeners.size).toBe(0)
    })

    test('skips dispatch when no committed output message exists', async () => {
        const listeners = new PluginChatOutputListeners()
        const listener = vi.fn()
        listeners.add(V2_CHAT_OUTPUT_OWNER, listener)

        await dispatchCommittedChatOutput(listeners, {
            ...output,
            messageIndex: -1,
        })

        expect(listener).not.toHaveBeenCalled()
    })

    test('dispatches a committed output message', async () => {
        const listeners = new PluginChatOutputListeners()
        const listener = vi.fn()
        listeners.add(V2_CHAT_OUTPUT_OWNER, listener)

        await dispatchCommittedChatOutput(listeners, output)

        expect(listener).toHaveBeenCalledOnce()
    })
})
