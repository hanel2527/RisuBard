import { describe, expect, test } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { classifyCharx, inspectCharx } from './charxPreflight'

function prependJpeg(bytes: Uint8Array) {
    // JPEG+ZIP exports retain offsets relative to the original ZIP.
    const prefix = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xd9)
    const combined = new Uint8Array(prefix.length + bytes.length)
    combined.set(prefix)
    combined.set(bytes, prefix.length)
    return combined
}

describe('CHARX installation type', () => {
    test('module suffix wins, including mixed case', () => {
        expect(classifyCharx('Pack.MODULE.CHARX', 1, 0)).toBe('module')
        expect(classifyCharx('module.charx', 1, 0)).toBe('character')
    })
    test('either inclusive threshold prompts, never forces conversion', () => {
        expect(classifyCharx('bot.charx', 149_999_999, 4999)).toBe('character')
        expect(classifyCharx('bot.charx', 150_000_000, 0)).toBe('ask')
        expect(classifyCharx('bot.charx', 1, 5000)).toBe('ask')
    })
    test('counts asset entries without expanding their payloads', async () => {
        const bytes = zipSync({ 'card.json': strToU8('{}'), 'module.risum': new Uint8Array(),
            'assets/': new Uint8Array(), 'assets/a.png': new Uint8Array(10000),
            'assets/b.webp': new Uint8Array(10000), 'x_meta/foo.json': strToU8('{}') })
        expect(await inspectCharx(bytes)).toEqual({ bytes: bytes.length, assets: 2 })
    })
    test('rejects incomplete ZIP before any import can start', async () => {
        await expect(inspectCharx(new Uint8Array(30))).rejects.toThrow()
    })
    test.each(['bytes', 'blob'])('counts JPEG-prefixed CHARX assets from %s', async type => {
        const bytes = prependJpeg(zipSync({ 'card.json': strToU8('{}'), 'assets/a.png': Uint8Array.of(1) }))
        const source = type === 'blob' ? new Blob([bytes]) : bytes
        expect(await inspectCharx(source)).toEqual({ bytes: bytes.length, assets: 1 })
    })
    test('reads ZIP64 directory metadata without expanding assets', async () => {
        const original = zipSync({ 'card.json': strToU8('{}'), 'assets/a.png': Uint8Array.of(1) })
        const end = original.length - 22
        const archive = new Uint8Array(original.length + 76)
        archive.set(original.subarray(0, end))
        archive.set(original.subarray(end), end + 76)
        const view = new DataView(archive.buffer)
        const old = new DataView(original.buffer)
        view.setUint32(end, 0x06064b50, true)
        view.setBigUint64(end + 4, 44n, true)
        view.setBigUint64(end + 24, 2n, true)
        view.setBigUint64(end + 32, 2n, true)
        view.setBigUint64(end + 40, BigInt(old.getUint32(end + 12, true)), true)
        view.setBigUint64(end + 48, BigInt(old.getUint32(end + 16, true)), true)
        view.setUint32(end + 56, 0x07064b50, true)
        view.setBigUint64(end + 64, BigInt(end), true)
        view.setUint32(end + 72, 1, true)
        view.setUint16(end + 76 + 10, 65535, true)
        expect((await inspectCharx(archive)).assets).toBe(1)
        const prefixed = prependJpeg(archive)
        expect((await inspectCharx(prefixed)).assets).toBe(1)
        expect((await inspectCharx(new Blob([prefixed]))).assets).toBe(1)
    })
})
