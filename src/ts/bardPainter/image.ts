import { muxPainterWebp, preparePainterPng } from './metadata'

/** Full-resolution WebP, with source NovelAI metadata or the resolved request as fallback. */
export async function compressPainterImage(
    png: Uint8Array,
    metadata: Record<string, unknown>,
): Promise<{ data: Uint8Array<ArrayBuffer>; width: number; height: number; mime: 'image/webp' }> {
    const prepared = preparePainterPng(png, metadata)
    const canvas = document.createElement('canvas')
    canvas.width = prepared.width
    canvas.height = prepared.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('이미지 압축에 필요한 캔버스를 열 수 없습니다.')
    const image = new Image()
    const url = URL.createObjectURL(new Blob([prepared.data], { type: 'image/png' }))
    try {
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve()
            image.onerror = () => reject(new Error('생성된 이미지를 읽을 수 없습니다.'))
            image.src = url
        })
        if (image.naturalWidth !== prepared.width || image.naturalHeight !== prepared.height) {
            throw new Error('생성된 이미지의 원본 크기를 확인할 수 없습니다.')
        }
        context.drawImage(image, 0, 0)
        const blob = await new Promise<Blob>((resolve, reject) => {
            // Browsers expose quality, but not libwebp's method/effort option.
            canvas.toBlob((result) => result ? resolve(result) : reject(new Error('WebP 압축에 실패했습니다.')), 'image/webp', 0.8)
        })
        const data = muxPainterWebp(new Uint8Array(await blob.arrayBuffer()), prepared)
        return { data, width: prepared.width, height: prepared.height, mime: 'image/webp' }
    } finally {
        image.onload = null
        image.onerror = null
        image.src = ''
        URL.revokeObjectURL(url)
        canvas.width = 0
        canvas.height = 0
    }
}
