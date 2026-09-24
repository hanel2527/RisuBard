import { unzlibSync } from 'fflate'

const utf8 = new TextDecoder()
const latin1 = (data: Uint8Array) => Array.from(data, (byte) => String.fromCharCode(byte)).join('')
const text = (value: string) => new TextEncoder().encode(value)
const viewOf = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength)
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** Read on demand for the image viewer; malformed metadata must not block the image. */
export function readPainterImageMetadata(source: Uint8Array): Record<string, unknown> {
    try {
        const view = viewOf(source)
        if (PNG_SIGNATURE.every((byte, i) => source[i] === byte)) {
            const result: Record<string, string> = Object.create(null)
            for (let offset = 8; offset + 12 <= source.length;) {
                const length = view.getUint32(offset)
                if (offset + 12 + length > source.length) break
                const kind = utf8.decode(source.subarray(offset + 4, offset + 8))
                if (['tEXt', 'zTXt', 'iTXt'].includes(kind)) {
                    const [key, value] = pngText(kind, source.subarray(offset + 8, offset + 8 + length))
                    result[key] = value
                }
                offset += 12 + length
            }
            return result
        }
        if (utf8.decode(source.subarray(0, 4)) !== 'RIFF' || utf8.decode(source.subarray(8, 12)) !== 'WEBP') return {}
        for (let offset = 12; offset + 8 <= source.length;) {
            const length = view.getUint32(offset + 4, true)
            if (offset + 8 + length > source.length) break
            if (utf8.decode(source.subarray(offset, offset + 4)) === 'EXIF') {
                let tiff = source.subarray(offset + 8, offset + 8 + length)
                if (utf8.decode(tiff.subarray(0, 6)) === 'Exif\0\0') tiff = tiff.subarray(6)
                const tv = viewOf(tiff), little = tiff[0] === 73
                if (tiff.length < 8 || (!little && tiff[0] !== 77) || tv.getUint16(2, little) !== 42) return {}
                const tag = (directory: number, id: number): number | undefined => {
                    if (directory < 8 || directory + 2 > tiff.length) return
                    const count = tv.getUint16(directory, little)
                    if (directory + 2 + count * 12 > tiff.length) return
                    for (let n = 0; n < count; n++) {
                        const start = directory + 2 + n * 12
                        if (tv.getUint16(start, little) === id) return start
                    }
                }
                const pointer = tag(tv.getUint32(4, little), 0x8769)
                if (pointer === undefined) return {}
                const comment = tag(tv.getUint32(pointer + 8, little), 0x9286)
                if (comment === undefined) return {}
                const size = tv.getUint32(comment + 4, little), start = tv.getUint32(comment + 8, little)
                if (size < 8 || start + size > tiff.length) return {}
                const payload = tiff.subarray(start, start + size), encoding = utf8.decode(payload.subarray(0, 8))
                const content = payload.subarray(8)
                // NovelAI's conversion convention is Unicode big endian, except an explicit BOM.
                const decoded = encoding.startsWith('UNICODE')
                    ? new TextDecoder(content[0] === 255 && content[1] === 254 ? 'utf-16le' : 'utf-16be').decode(content)
                    : utf8.decode(content)
                const value = JSON.parse(decoded.replace(/\0+$/, ''))
                return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
            }
            offset += 8 + length + (length % 2)
        }
    } catch { /* The image remains viewable if its metadata is missing or damaged. */ }
    return {}
}

function join(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
    let offset = 0
    for (const part of parts) {
        output.set(part, offset)
        offset += part.length
    }
    return output
}

export interface PreparedPainterPng {
    data: Uint8Array<ArrayBuffer>
    width: number
    height: number
    exif: Uint8Array
    icc?: Uint8Array
}

function safeRequestMetadata(metadata: Record<string, unknown>): string {
    return JSON.stringify(metadata, (key, value) =>
        /^(?:.*token|.*api[_-]?key|authorization|password|secret|credentials?|headers)$/i.test(key) ? undefined : value)
}

function pngText(kind: string, data: Uint8Array): [string, string] {
    const separator = data.indexOf(0)
    if (separator < 1) throw new Error('PNG 텍스트 메타데이터가 손상되었습니다.')
    const key = latin1(data.subarray(0, separator))
    if (kind === 'tEXt') return [key, latin1(data.subarray(separator + 1))]
    if (kind === 'zTXt') {
        if (data[separator + 1] !== 0) throw new Error('지원하지 않는 PNG 메타데이터 압축입니다.')
        return [key, latin1(unzlibSync(data.subarray(separator + 2)))]
    }
    const compressed = data[separator + 1]
    if (compressed > 1 || data[separator + 2] !== 0) throw new Error('PNG 텍스트 메타데이터가 손상되었습니다.')
    const languageEnd = data.indexOf(0, separator + 3)
    const translatedEnd = data.indexOf(0, languageEnd + 1)
    if (languageEnd < 0 || translatedEnd < 0) throw new Error('PNG 텍스트 메타데이터가 손상되었습니다.')
    const value = data.subarray(translatedEnd + 1)
    return [key, utf8.decode(compressed ? unzlibSync(value) : value)]
}

/** Keep the user's Python script's NovelAI envelope and Unicode UserComment convention. */
function buildUserComment(sourceText: Record<string, string>, metadata: Record<string, unknown>): string {
    const values = { ...sourceText }
    if (!values.Comment) {
        values.Comment = safeRequestMetadata(metadata)
        values.Software ??= 'RisuBard BardPainter'
    }
    try {
        JSON.parse(values.Comment)
        if (values.Generation_time !== undefined) {
            values['Generation time'] = values.Generation_time
            delete values.Generation_time
        }
        return JSON.stringify(values)
    } catch {
        return Object.entries(values).map(([key, value]) => `${key}: ${value}`).join('\n')
    }
}

/** Append TIFF directories instead of relocating existing data and invalidating offsets. */
function withUserComment(original: Uint8Array | undefined, comment: string): Uint8Array {
    let tiff = original
    if (tiff && utf8.decode(tiff.subarray(0, 6)) === 'Exif\0\0') tiff = tiff.subarray(6)
    tiff ??= new Uint8Array([73, 73, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const view = viewOf(tiff)
    const little = tiff[0] === 73 && tiff[1] === 73
    if (tiff.length < 8 || (!little && (tiff[0] !== 77 || tiff[1] !== 77)) || view.getUint16(2, little) !== 42) {
        throw new Error('PNG EXIF 메타데이터가 손상되었습니다.')
    }
    const entries = (offset: number) => {
        if (offset < 8 || offset + 2 > tiff.length) throw new Error('EXIF 디렉터리가 손상되었습니다.')
        const count = view.getUint16(offset, little)
        if (offset + 2 + count * 12 + 4 > tiff.length) throw new Error('EXIF 디렉터리가 손상되었습니다.')
        return {
            tags: Array.from({ length: count }, (_, n) => tiff.slice(offset + 2 + n * 12, offset + 14 + n * 12)),
            next: view.getUint32(offset + 2 + count * 12, little),
        }
    }
    const tagId = (entry: Uint8Array) => viewOf(entry).getUint16(0, little)
    const root = entries(view.getUint32(4, little))
    const pointer = root.tags.find((entry) => tagId(entry) === 0x8769)
    const exif = pointer ? entries(viewOf(pointer).getUint32(8, little)) : { tags: [], next: 0 }
    if (exif.tags.some((entry) => tagId(entry) === 0x9286 && viewOf(entry).getUint32(4, little) > 0)) return tiff.slice()

    const payload = new Uint8Array(8 + comment.length * 2)
    payload.set(text('UNICODE\0'))
    const payloadView = viewOf(payload)
    for (let n = 0; n < comment.length; n++) payloadView.setUint16(8 + n * 2, comment.charCodeAt(n))

    const alignedLength = tiff.length + (tiff.length % 2)
    const rootOffset = alignedLength
    const rootTags = root.tags.filter((entry) => tagId(entry) !== 0x8769)
    const exifTags = exif.tags.filter((entry) => tagId(entry) !== 0x9286)
    const exifOffset = rootOffset + 2 + (rootTags.length + 1) * 12 + 4
    const commentOffset = exifOffset + 2 + (exifTags.length + 1) * 12 + 4
    const makeTag = (tag: number, type: number, count: number, value: number) => {
        const data = new Uint8Array(12)
        const tagView = viewOf(data)
        tagView.setUint16(0, tag, little)
        tagView.setUint16(2, type, little)
        tagView.setUint32(4, count, little)
        tagView.setUint32(8, value, little)
        return data
    }
    rootTags.push(makeTag(0x8769, 4, 1, exifOffset))
    exifTags.push(makeTag(0x9286, 7, payload.length, commentOffset))
    const output = new Uint8Array(commentOffset + payload.length)
    output.set(tiff)
    const outputView = viewOf(output)
    outputView.setUint32(4, rootOffset, little)
    const writeDirectory = (offset: number, tags: Uint8Array[], next: number) => {
        tags.sort((a, b) => tagId(a) - tagId(b))
        outputView.setUint16(offset, tags.length, little)
        tags.forEach((tag, n) => output.set(tag, offset + 2 + n * 12))
        outputView.setUint32(offset + 2 + tags.length * 12, next, little)
    }
    writeDirectory(rootOffset, rootTags, root.next)
    writeDirectory(exifOffset, exifTags, exif.next)
    output.set(payload, commentOffset)
    return output
}

/** Parse before decoding so the browser cannot discard the original generation metadata. */
export function preparePainterPng(source: Uint8Array, metadata: Record<string, unknown>): PreparedPainterPng {
    if (!PNG_SIGNATURE.every((byte, i) => source[i] === byte)) throw new Error('생성된 이미지가 PNG 형식이 아닙니다.')
    const view = viewOf(source)
    const chunks: { kind: string; bytes: Uint8Array }[] = []
    const sourceText: Record<string, string> = Object.create(null)
    let width = 0, height = 0
    let icc: Uint8Array | undefined, exif: Uint8Array | undefined
    let ended = false
    for (let offset = 8; offset < source.length;) {
        if (offset + 12 > source.length) throw new Error('PNG 이미지가 잘렸습니다.')
        const length = view.getUint32(offset)
        const end = offset + 12 + length
        if (end > source.length) throw new Error('PNG 이미지가 잘렸습니다.')
        const kind = utf8.decode(source.subarray(offset + 4, offset + 8))
        const data = source.subarray(offset + 8, end - 4)
        if (kind === 'IHDR') {
            if (offset !== 8 || length !== 13) throw new Error('PNG 헤더가 손상되었습니다.')
            width = view.getUint32(offset + 8)
            height = view.getUint32(offset + 12)
        } else if (['tEXt', 'zTXt', 'iTXt'].includes(kind)) {
            const [key, value] = pngText(kind, data)
            sourceText[key] = value
        } else if (kind === 'iCCP') {
            const separator = data.indexOf(0)
            if (separator < 1 || data[separator + 1] !== 0) throw new Error('PNG 색상 프로필이 손상되었습니다.')
            icc = unzlibSync(data.subarray(separator + 2))
        } else if (kind === 'eXIf') {
            exif = data
        }
        chunks.push({ kind, bytes: source.subarray(offset, end) })
        offset = end
        if (kind === 'IEND') { ended = true; break }
    }
    if (!ended || !width || !height || width > 16383 || height > 16383) throw new Error('PNG 이미지 크기 또는 구조를 확인할 수 없습니다.')
    // With an ICC profile, encode unconverted RGB values then reattach that profile.
    // Strip EXIF before browser decoding so orientation is not applied twice.
    const excluded = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', ...(icc ? ['iCCP', 'gAMA', 'cHRM', 'sRGB'] : [])])
    return {
        data: join([source.subarray(0, 8), ...chunks.filter(({ kind }) => !excluded.has(kind)).map(({ bytes }) => bytes)]),
        width, height, icc,
        exif: withUserComment(exif, buildUserComment(sourceText, metadata)),
    }
}

function riffChunk(kind: string, data: Uint8Array): Uint8Array {
    const output = new Uint8Array(8 + data.length + (data.length % 2))
    output.set(text(kind))
    viewOf(output).setUint32(4, data.length, true)
    output.set(data, 8)
    return output
}

/** Add ICC and EXIF to a browser-encoded WebP, retaining its compressed pixel payload. */
export function muxPainterWebp(encoded: Uint8Array, metadata: PreparedPainterPng): Uint8Array<ArrayBuffer> {
    if (encoded.length < 20 || utf8.decode(encoded.subarray(0, 4)) !== 'RIFF' || utf8.decode(encoded.subarray(8, 12)) !== 'WEBP') {
        throw new Error('이 환경에서 WebP 압축을 지원하지 않습니다.')
    }
    const view = viewOf(encoded)
    if (view.getUint32(4, true) + 8 !== encoded.length) throw new Error('WebP 이미지가 잘렸습니다.')
    const chunks: { kind: string; data: Uint8Array }[] = []
    for (let offset = 12; offset < encoded.length;) {
        if (offset + 8 > encoded.length) throw new Error('WebP 이미지가 잘렸습니다.')
        const length = view.getUint32(offset + 4, true)
        const end = offset + 8 + length
        if (end + (length % 2) > encoded.length) throw new Error('WebP 이미지가 잘렸습니다.')
        chunks.push({ kind: utf8.decode(encoded.subarray(offset, offset + 4)), data: encoded.subarray(offset + 8, end) })
        offset = end + (length % 2)
    }
    if (chunks.some(({ kind }) => kind === 'ANIM' || kind === 'ANMF')) throw new Error('움직이는 WebP는 지원하지 않습니다.')
    const pixels = chunks.find(({ kind }) => kind === 'VP8 ' || kind === 'VP8L')
    if (!pixels) throw new Error('WebP 이미지 데이터가 없습니다.')
    let width: number, height: number
    if (pixels.kind === 'VP8 ' && pixels.data.length >= 10) {
        width = viewOf(pixels.data).getUint16(6, true) & 0x3fff
        height = viewOf(pixels.data).getUint16(8, true) & 0x3fff
    } else if (pixels.kind === 'VP8L' && pixels.data.length >= 5) {
        const bits = viewOf(pixels.data).getUint32(1, true)
        width = (bits & 0x3fff) + 1
        height = ((bits >>> 14) & 0x3fff) + 1
    } else throw new Error('WebP 이미지 데이터가 손상되었습니다.')
    if (width !== metadata.width || height !== metadata.height) throw new Error('WebP 압축 중 이미지 크기가 변경되었습니다.')
    const alpha = chunks.some(({ kind }) => kind === 'ALPH') || (pixels.kind === 'VP8L' && !!(pixels.data[4] & 0x10))
    const xmp = chunks.find(({ kind }) => kind === 'XMP ')
    const vp8x = new Uint8Array(10)
    vp8x[0] = 0x08 | (metadata.icc ? 0x20 : 0) | (alpha ? 0x10 : 0) | (xmp ? 0x04 : 0)
    for (let n = 0; n < 3; n++) {
        vp8x[4 + n] = ((width - 1) >>> (n * 8)) & 0xff
        vp8x[7 + n] = ((height - 1) >>> (n * 8)) & 0xff
    }
    const parts = [riffChunk('VP8X', vp8x)]
    if (metadata.icc) parts.push(riffChunk('ICCP', metadata.icc))
    for (const { kind, data } of chunks) {
        if (!['VP8X', 'ICCP', 'EXIF', 'XMP '].includes(kind)) parts.push(riffChunk(kind, data))
    }
    parts.push(riffChunk('EXIF', metadata.exif))
    if (xmp) parts.push(riffChunk('XMP ', xmp.data))
    const header = new Uint8Array(12)
    header.set(text('RIFF'))
    header.set(text('WEBP'), 8)
    viewOf(header).setUint32(4, 4 + parts.reduce((size, part) => size + part.length, 0), true)
    return join([header, ...parts])
}
