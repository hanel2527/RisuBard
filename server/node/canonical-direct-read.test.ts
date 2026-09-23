import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const source = fs.readFileSync(path.join(__dirname, 'server.cjs'), 'utf8')
const body = source.slice(source.indexOf('async function prepareDatabaseRead('), source.indexOf('\nfunction sendStorageEtagConflict('))

function setup(overrides: Record<string, unknown> = {}) {
    const stripped = { characters: [{ chaId: 'a', chats: [{ id: 'b', _stub: true }] }] }
    const context = {
        canonicalProjectionReady: true,
        isRemoteMigrationDone: () => true,
        externalEditSession: { isActive: () => false },
        userDataRepository: { loadStartupDatabase: vi.fn(() => stripped) },
        flushPendingDbWithinQueue: vi.fn(async () => {}),
        normalizeJSON: (value: unknown) => value,
        normalizeOrphanFolderIds: () => false,
        dbCache: {} as Record<string, unknown>, dbEtag: null,
        encodeRisuSaveLegacyBuffer: (value: unknown) => Buffer.from(JSON.stringify(value)),
        computeBufferEtag: () => 'etag',
        readStorageItemPayload: vi.fn(async () => Buffer.from('legacy')),
        decodeDatabaseWithPersistentChatIds: vi.fn(async () => ({ characters: [] })),
        initChatStore: vi.fn(), stripChatsFromDb: (value: unknown) => value,
        logger: { warn: vi.fn(), error: vi.fn() }, ...overrides,
    }
    vm.createContext(context)
    const read = vm.runInContext(`${body}; prepareDatabaseRead`, context)
    return { context, read }
}

describe('canonical startup route', () => {
    it('flushes pending writes without materializing or decoding the compatibility database', async () => {
        const { context, read } = setup()
        const result = await read('hex', 'database/database.bin', { flush: true })
        expect(context.flushPendingDbWithinQueue).toHaveBeenCalledWith({ materialize: false })
        expect(context.readStorageItemPayload).not.toHaveBeenCalled()
        expect(context.initChatStore).not.toHaveBeenCalled()
        expect(JSON.parse(result.value.toString())).toEqual(context.dbCache.hex)
        expect(result.etag).toBe('etag')
    })
    it.each([
        { canonicalProjectionReady: false },
        { isRemoteMigrationDone: () => false },
        { externalEditSession: { isActive: () => true } },
        { userDataRepository: { loadStartupDatabase: () => { throw new Error('unavailable') } } },
        { normalizeOrphanFolderIds: () => true },
    ])('retains the legacy migration and recovery reader: %j', async overrides => {
        const { context, read } = setup(overrides)
        await read('hex', 'database/database.bin')
        expect(context.readStorageItemPayload).toHaveBeenCalledOnce()
        expect(context.decodeDatabaseWithPersistentChatIds).toHaveBeenCalledOnce()
        expect(context.initChatStore).toHaveBeenCalledOnce()
    })
})
