const encoder = new TextEncoder()

export function getMessageSize(message: { data: string }): { bodyBytes: number, totalBytes: number } {
    return {
        bodyBytes: encoder.encode(message.data).byteLength,
        totalBytes: encoder.encode(JSON.stringify(message)).byteLength,
    }
}
