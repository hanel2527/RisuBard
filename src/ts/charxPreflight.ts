export function classifyCharx(name: string, bytes: number, assets: number): 'module' | 'character' | 'ask' {
    if (name.toLowerCase().endsWith('.module.charx')) return 'module'
    return bytes >= 150_000_000 || assets >= 5000 ? 'ask' : 'character'
}

// Read the central directory only. No decompression and no asset writes.
export async function inspectCharx(source: Uint8Array | Blob, check = () => {}) {
    const size = source instanceof Uint8Array ? source.byteLength : source.size
    let cached = new Uint8Array(0)
    let cachedStart = 0
    const read = async (start: number, length: number) => {
        if (source instanceof Uint8Array) return source.subarray(start, start + length)
        if (start < cachedStart || start + length > cachedStart + cached.length) {
            cachedStart = start
            cached = new Uint8Array(await source.slice(start, start + Math.max(length, 65536)).arrayBuffer())
        }
        return cached.subarray(start - cachedStart, start - cachedStart + length)
    }
    const tailStart = Math.max(0, size - 65557)
    const tail = await read(tailStart, size - tailStart)
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
    let end = -1
    for (let i = tail.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === tail.length) {
            end = i; break
        }
    }
    if (end < 0) throw new Error('CHARX ZIP directory is missing or incomplete')
    let entries = view.getUint16(end + 10, true)
    let directorySize = view.getUint32(end + 12, true)
    let directoryOffset = view.getUint32(end + 16, true)
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) {
        throw new Error('Split CHARX archives are not supported')
    }
    if (entries === 65535 || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
        const locatorBytes = await read(tailStart + end - 20, 20)
        const locator = new DataView(locatorBytes.buffer, locatorBytes.byteOffset, locatorBytes.byteLength)
        if (locator.getUint32(0, true) !== 0x07064b50 || locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) !== 1) {
            throw new Error('Invalid CHARX ZIP64 locator')
        }
        const offset = Number(locator.getBigUint64(8, true))
        if (!Number.isSafeInteger(offset) || offset < 0 || offset + 56 > tailStart + end - 20) throw new Error('Invalid CHARX ZIP64 offset')
        const bytes = await read(offset, 56)
        const zip64 = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        if (zip64.getUint32(0, true) !== 0x06064b50 || zip64.getUint32(16, true) || zip64.getUint32(20, true)) throw new Error('Invalid CHARX ZIP64 directory')
        entries = Number(zip64.getBigUint64(32, true))
        directorySize = Number(zip64.getBigUint64(40, true))
        directoryOffset = Number(zip64.getBigUint64(48, true))
        if (![entries, directorySize, directoryOffset].every(Number.isSafeInteger)) throw new Error('CHARX ZIP64 directory is too large')
    }
    if (directoryOffset + directorySize > tailStart + end) throw new Error('Invalid CHARX ZIP directory')
    let assets = 0
    let position = directoryOffset
    for (let i = 0; i < entries; i++) {
        check()
        const header = await read(position, 46)
        if (header.length !== 46) throw new Error('Truncated CHARX ZIP entry')
        const entry = new DataView(header.buffer, header.byteOffset, header.byteLength)
        if (entry.getUint32(0, true) !== 0x02014b50) throw new Error('Invalid CHARX ZIP entry')
        const nameLength = entry.getUint16(28, true)
        const name = new TextDecoder().decode(await read(position + 46, nameLength))
        if (!name.endsWith('/') && !name.toLowerCase().endsWith('.json') && name !== 'module.risum') assets++
        position += 46 + nameLength + entry.getUint16(30, true) + entry.getUint16(32, true)
        if (position > directoryOffset + directorySize) throw new Error('Truncated CHARX ZIP directory')
        if (i % 200 === 0) await new Promise(resolve => setTimeout(resolve, 0))
    }
    return { bytes: size, assets }
}
