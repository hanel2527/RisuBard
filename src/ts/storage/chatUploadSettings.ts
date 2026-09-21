export const DEFAULT_CHAT_UPLOAD_CHUNK_MIB = 8
export const MIN_CHAT_UPLOAD_CHUNK_MIB = 1
export const MAX_CHAT_UPLOAD_CHUNK_MIB = 64

export function normalizeChatUploadChunkMiB(value: unknown): number {
    if (value === undefined || value === null || value === '') return DEFAULT_CHAT_UPLOAD_CHUNK_MIB
    const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
    if (!Number.isFinite(number)) return DEFAULT_CHAT_UPLOAD_CHUNK_MIB
    return Math.max(MIN_CHAT_UPLOAD_CHUNK_MIB, Math.min(MAX_CHAT_UPLOAD_CHUNK_MIB, Math.floor(number)))
}
