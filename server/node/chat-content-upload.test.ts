import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { uploadChatContent, CHAT_UPLOAD_CHUNK_BYTES } from '../../src/ts/storage/chatContentUpload'

const { createChatContentUploads } = require('./chat-content-upload.cjs')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function setup(options = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'chat-upload-test-'))
    const store = createChatContentUploads({ root, ...options })
    cleanup.push(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
    return { root, store }
}
function chunk(index: number, body = 'abcd', overrides: Record<string, string> = {}) {
    return {
        params: { chaId: 'character', chatIndex: '0' },
        headers: { 'x-upload-id': 'upload-1', 'x-session-id': 'session', 'x-chat-id': 'chat',
            'x-upload-size': '8', 'x-upload-index': String(index), ...overrides },
        body: Buffer.from(body),
    }
}

test('a chat over 100 MiB round-trips byte for byte using requests no larger than 8 MiB', async () => {
    const { root, store } = await setup()
    const payload = Buffer.alloc(100 * 1024 * 1024 + 17, 0xa5)
    payload[payload.length - 1] = 0x7f
    let committed: Buffer | undefined
    let requests = 0
    const response = await uploadChatContent(async (url, init) => {
        expect(url).toBe('/api/chat-content-upload/character/0')
        expect(init.method).toBe('POST')
        const body = Buffer.from(init.body as Uint8Array)
        expect(body.length).toBeLessThanOrEqual(CHAT_UPLOAD_CHUNK_BYTES)
        const result = await store.accept({ params: { chaId: 'character', chatIndex: '0' },
            headers: { ...init.headers, 'x-session-id': 'session' }, body })
        requests++
        if (result.body) {
            committed = result.body
            return Response.json({ success: true })
        }
        expect(committed).toBeUndefined()
        return Response.json(result, { status: 202 })
    }, 'character', 0, 'chat', payload, 8, true)
    expect(response.ok).toBe(true)
    expect(requests).toBe(13)
    expect(committed!.equals(payload)).toBe(true)
    expect(await readdir(root)).toEqual([])
})

test('small chats keep the existing single-request endpoint', async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ success: true }))
    await uploadChatContent(request, 'char/escaped', 2, 'chat', new Uint8Array([1, 2]))
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][0]).toBe('/api/chat-content/char%2Fescaped/2')
})

test.each([undefined, false])('unset or disabled chunk uploads (%s) send a large chat once without chunk metadata', async enabled => {
    const payload = new Uint8Array(CHAT_UPLOAD_CHUNK_BYTES + 1)
    const request = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ success: true }))
    await uploadChatContent(request, 'character', 0, 'chat', payload, 1, enabled)
    expect(request).toHaveBeenCalledOnce()
    const [url, init] = request.mock.calls[0]
    expect(url).toBe('/api/chat-content/character/0')
    expect(init.body).toBe(payload)
    expect(new Headers(init.headers).has('x-upload-index')).toBe(false)
})

test.each([1, 16, 64])('the server accepts the app setting of %i MiB without separate configuration', async chunkMiB => {
    const { store, root } = await setup()
    const bytes = chunkMiB * 1024 * 1024
    const payload = Buffer.alloc(bytes + 17, 0xa5)
    payload.fill(0x7f, bytes)
    const lengths: number[] = []
    let committed: Buffer | undefined
    await uploadChatContent(async (_url, init) => {
        const body = Buffer.from(init.body as Uint8Array)
        lengths.push(body.length)
        expect(new Headers(init.headers).get('x-upload-chunk-size')).toBe(String(bytes))
        const result = await store.accept({ params: { chaId: 'character', chatIndex: '0' },
            headers: { ...init.headers, 'x-session-id': 'session' }, body })
        if (result.body) {
            committed = result.body
            return Response.json({ success: true })
        }
        return Response.json(result, { status: 202 })
    }, 'character', 0, 'chat', payload, chunkMiB, true)
    expect(lengths).toEqual([bytes, 17])
    expect(committed!.equals(payload)).toBe(true)
    expect(await readdir(root)).toEqual([])
})

test('an in-flight upload keeps its initial chunk size even if another request changes it', async () => {
    const { store } = await setup()
    const mib = 1024 * 1024
    const request = (index: number, chunkSize = mib) => ({
        ...chunk(index), body: Buffer.alloc(mib, index),
        headers: { ...chunk(index).headers, 'x-upload-size': String(3 * mib), 'x-upload-chunk-size': String(chunkSize) },
    })
    await store.accept(request(0))
    await expect(store.accept(request(1, 2 * mib))).rejects.toMatchObject({ status: 409 })
    await store.accept(request(1))
    const { body } = await store.accept(request(2))
    expect(body.equals(Buffer.concat([Buffer.alloc(mib, 0), Buffer.alloc(mib, 1), Buffer.alloc(mib, 2)]))).toBe(true)
})

test.each(['0', String(65 * 1024 * 1024), String(1.5 * 1024 * 1024), 'NaN'])(
    'the server rejects invalid chunk-size metadata %s', async value => {
        const { store, root } = await setup()
        await expect(store.accept(chunk(0, 'abcd', { 'x-upload-chunk-size': value }))).rejects.toMatchObject({ status: 400 })
        expect(await readdir(root)).toEqual([])
    },
)

test('missing, reordered, wrong-sized and cross-session chunks cannot complete an upload', async () => {
    const { store, root } = await setup({ chunkBytes: 4, maxBytes: 16 })
    await expect(store.accept(chunk(1))).rejects.toMatchObject({ status: 409 })
    await expect(store.accept(chunk(0, 'bad'))).rejects.toMatchObject({ status: 400 })
    expect(await store.accept(chunk(0))).toEqual({ uploadId: 'upload-1', nextIndex: 1 })
    await expect(store.accept(chunk(0))).rejects.toMatchObject({ status: 409 })
    await expect(store.accept(chunk(1, 'efgh', { 'x-session-id': 'other' }))).rejects.toMatchObject({ status: 409 })
    await expect(store.accept(chunk(1, 'efgh', { 'x-chat-id': 'other' }))).rejects.toMatchObject({ status: 409 })
    await expect(store.abort(chunk(1, '', { 'x-session-id': 'other' }))).rejects.toMatchObject({ status: 409 })
    expect((await store.accept(chunk(1, 'efgh'))).body.toString()).toBe('abcdefgh')
    expect(await readdir(root)).toEqual([])
})

test('aborted and expired uploads free staging capacity without publishing data', async () => {
    let time = 0
    const { store, root } = await setup({ chunkBytes: 4, maxBytes: 8, ttlMs: 10_000, now: () => time })
    await store.accept(chunk(0))
    await expect(store.accept(chunk(0, 'abcd', { 'x-upload-id': 'upload-2' }))).rejects.toMatchObject({ status: 429 })
    time = 10_001
    await expect(store.accept(chunk(1))).rejects.toMatchObject({ status: 409 })
    expect(await readdir(root)).toEqual([])
    await store.accept(chunk(0))
    await store.abort(chunk(0))
    expect(await readdir(root)).toEqual([])
    await expect(store.accept(chunk(0, 'abcd', { 'x-upload-size': '9' }))).rejects.toMatchObject({ status: 413 })
})

test.each(['network', 'conflict', 'bad-ack'])('client aborts on %s without committing or sending later chunks', async failure => {
    const calls: string[] = []
    const request = async (_url: string, init: RequestInit) => {
        calls.push(init.method!)
        if (init.method === 'DELETE') return Response.json({ success: true })
        if (failure === 'network') throw new Error('offline')
        if (failure === 'conflict') return Response.json({ code: 'CANONICAL_FILES_CHANGED' }, { status: 409 })
        return Response.json({ uploadId: 'wrong', nextIndex: 1 }, { status: 202 })
    }
    const result = uploadChatContent(request, 'character', 0, 'chat', new Uint8Array(CHAT_UPLOAD_CHUNK_BYTES + 1), 8, true)
    if (failure === 'conflict') {
        const response = await result
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ code: 'CANONICAL_FILES_CHANGED' })
    } else await expect(result).rejects.toThrow()
    expect(calls).toEqual(['POST', 'DELETE'])
})
