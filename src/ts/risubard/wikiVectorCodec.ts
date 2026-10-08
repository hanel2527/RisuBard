// Compact storage for cached embedding vectors: "RBV1" + little-endian Float32.
// JSON arrays (the earlier format) take about five times the bytes to store,
// transfer and parse, which dominated cold loads of long chats.
const MAGIC = [0x52, 0x42, 0x56, 0x31]

export function encodeWikiVector(vector: readonly number[]): Uint8Array {
    const bytes = new Uint8Array(MAGIC.length + vector.length * 4)
    bytes.set(MAGIC)
    const view = new DataView(bytes.buffer)
    vector.forEach((value, index) => view.setFloat32(MAGIC.length + index * 4, value, true))
    return bytes
}

/** Decodes either format; `legacy` marks a JSON entry worth rewriting compactly. */
export function decodeWikiVector(data: Uint8Array): { vector: number[] | undefined; legacy: boolean } {
    const binary = data.byteLength > MAGIC.length
        && MAGIC.every((byte, index) => data[index] === byte)
    if (binary) {
        if ((data.byteLength - MAGIC.length) % 4 !== 0) return { vector: undefined, legacy: false }
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
        const vector = new Array<number>((data.byteLength - MAGIC.length) / 4)
        for (let index = 0; index < vector.length; index++) {
            vector[index] = view.getFloat32(MAGIC.length + index * 4, true)
        }
        return { vector, legacy: false }
    }
    try {
        const value: unknown = JSON.parse(new TextDecoder().decode(data))
        return Array.isArray(value) && value.every((item) => typeof item === 'number')
            ? { vector: value, legacy: true }
            : { vector: undefined, legacy: false }
    }
    catch {
        return { vector: undefined, legacy: false }
    }
}
