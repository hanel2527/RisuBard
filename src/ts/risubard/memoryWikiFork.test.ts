import { afterEach, describe, expect, test, vi } from 'vitest'
import { completeMemoryWikiFork, forkMemoryWiki } from './memoryWikiFork'
import { RISUBARD_MEMORY_UPDATED_EVENT } from './memoryEvents'

afterEach(() => vi.restoreAllMocks())

describe('memory wiki fork client', () => {
    test('sends an authenticated strict copy request and validates the receipt', async () => {
        const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
            mode: 'copy', sourceExists: true,
            destinationChatId: 'copy', warnings: [], forkToken: 'token-1',
        }), { status: 200, headers: { 'content-type': 'application/json' } }))

        await expect(forkMemoryWiki({
            characterId: 'character', sourceChatId: 'source',
            destinationChatId: 'copy', mode: 'copy', fetchImpl,
            createAuth: async () => 'token',
        })).resolves.toEqual({
            mode: 'copy', sourceExists: true,
            destinationChatId: 'copy', warnings: [], forkToken: 'token-1',
        })

        expect(fetchImpl).toHaveBeenCalledWith(
            '/api/risubard/memory/fork',
            expect.objectContaining({
                method: 'POST', credentials: 'same-origin',
                headers: {
                    'content-type': 'application/json',
                    'risu-auth': 'token',
                },
                body: JSON.stringify({
                    characterId: 'character', sourceChatId: 'source',
                    destinationChatId: 'copy', mode: 'copy',
                }),
            })
        )
    })

    test('sends a distinct destination character for a character clone', async () => {
        const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
            mode: 'copy', sourceExists: true,
            destinationChatId: 'copy', warnings: [], forkToken: 'token-1',
        }), { status: 200 }))

        await forkMemoryWiki({
            characterId: 'source-character',
            destinationCharacterId: 'cloned-character',
            sourceChatId: 'source', destinationChatId: 'copy', mode: 'copy',
            fetchImpl, createAuth: async () => 'token',
        })

        expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toEqual({
            characterId: 'source-character',
            destinationCharacterId: 'cloned-character',
            sourceChatId: 'source', destinationChatId: 'copy', mode: 'copy',
        })
    })

    test('sends the retained stable message IDs for a branch', async () => {
        const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
            mode: 'branch', sourceExists: true,
            destinationChatId: 'branch', warnings: ['audit reset'],
            forkToken: 'token-2',
        }), { status: 200 }))

        await forkMemoryWiki({
            characterId: 'character', sourceChatId: 'source',
            destinationChatId: 'branch', mode: 'branch',
            retainedMessageIds: ['user-1', 'assistant-1'],
            messageIds: [
                'user-1', 'assistant-1', 'user-2', 'assistant-2',
            ],
            fetchImpl, createAuth: async () => 'token',
        })

        const request = fetchImpl.mock.calls[0]
        expect(request).toBeDefined()
        expect(JSON.parse(request?.[1]?.body as string))
            .toEqual({
                characterId: 'character', sourceChatId: 'source',
                destinationChatId: 'branch', mode: 'branch',
                retainedMessageIds: ['user-1', 'assistant-1'],
                messageIds: [
                    'user-1', 'assistant-1', 'user-2', 'assistant-2',
                ],
            })
    })

    test('finalizes or discards a published fork with its token', async () => {
        const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
            JSON.stringify({ action: 'discard', completed: true }),
            { status: 200 }
        ))

        await expect(completeMemoryWikiFork({
            characterId: 'character', destinationChatId: 'copy',
            forkToken: 'token-1', action: 'discard', fetchImpl,
            createAuth: async () => 'auth',
        })).resolves.toEqual({ action: 'discard', completed: true })
        expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string))
            .toEqual({
                characterId: 'character', destinationChatId: 'copy',
                forkToken: 'token-1', action: 'discard',
            })
    })

    test('retries an uncertain finalize with the same token', async () => {
        const dispatch = vi.spyOn(window, 'dispatchEvent')
        let attempt = 0
        const fetchImpl = vi.fn(async () => {
            attempt += 1
            if (attempt === 1) throw new TypeError('response lost')
            return new Response(JSON.stringify({
                action: 'finalize', completed: true,
            }), { headers: { 'content-type': 'application/json' } })
        }) as unknown as typeof fetch

        await expect(completeMemoryWikiFork({
            characterId: 'character', destinationChatId: 'chat',
            forkToken: 'token-1', action: 'finalize', fetchImpl,
            createAuth: async () => 'auth',
        })).resolves.toEqual({ action: 'finalize', completed: true })
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        const updates = dispatch.mock.calls.map(([event]) => event)
            .filter(event => event.type === RISUBARD_MEMORY_UPDATED_EVENT) as CustomEvent[]
        expect(updates).toHaveLength(1)
        expect(updates[0].detail).toEqual({ characterId: 'character', chatId: 'chat' })
    })

    test('does not announce a restored wiki on discard or failed finalization', async () => {
        const dispatch = vi.spyOn(window, 'dispatchEvent')
        const input = {
            characterId: 'character', destinationChatId: 'chat', forkToken: 'token',
            createAuth: async () => 'auth',
        }
        await completeMemoryWikiFork({
            ...input, action: 'discard',
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({ action: 'discard', completed: true }))),
        })
        await expect(completeMemoryWikiFork({
            ...input, action: 'finalize',
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: 'failed' }), { status: 500 })),
        })).rejects.toThrow('status 500')
        expect(dispatch.mock.calls.some(([event]) => event.type === RISUBARD_MEMORY_UPDATED_EVENT)).toBe(false)
    })

    test('rejects HTTP failures and malformed success receipts', async () => {
        await expect(forkMemoryWiki({
            characterId: 'character', sourceChatId: 'source',
            destinationChatId: 'copy', mode: 'copy',
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({
                error: 'Memory fork conflict: manual edit contains future sources',
            }), {
                status: 409,
                headers: { 'content-type': 'application/json' },
            })),
            createAuth: async () => 'token',
        })).rejects.toThrow(
            'status 409: Memory fork conflict: manual edit contains future sources'
        )

        await expect(forkMemoryWiki({
            characterId: 'character', sourceChatId: 'source',
            destinationChatId: 'copy', mode: 'copy',
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({
                mode: 'copy', destinationChatId: 'wrong', warnings: [],
                forkToken: 'token-1',
            }), { status: 200 })),
            createAuth: async () => 'token',
        })).rejects.toThrow('Invalid memory fork receipt')

        await expect(completeMemoryWikiFork({
            characterId: 'character', destinationChatId: 'copy',
            forkToken: 'token-1', action: 'finalize',
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({
                action: 'finalize', completed: false,
            }), { status: 200 })),
            createAuth: async () => 'token',
        })).rejects.toThrow('Invalid memory fork completion receipt')
    })
})
