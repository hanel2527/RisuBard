export function findSingleProtonLink(description: string): string | null {
    const links = new Set<string>()
    for (const candidate of description.match(/https:\/\/[^\s<>"'`]+/gi) ?? []) {
        try {
            const url = new URL(candidate.replace(/[)\]},.;!?]+$/, ''))
            if (url.protocol !== 'https:' || !['drive.proton.me', 'drive.proton.ch'].includes(url.hostname)
                || url.port || url.username || url.password || !/^\/urls\/[a-z0-9]+\/?$/i.test(url.pathname)
                || !/^#[a-z0-9_-]+$/i.test(url.hash)) continue
            // Tracking parameters and a trailing slash do not identify a different share.
            url.search = ''
            url.pathname = url.pathname.replace(/\/$/, '')
            links.add(url.href)
        } catch { /* Not a usable public share URL. */ }
    }
    return links.size === 1 ? [...links][0] : null
}

export type ProtonModuleResult = { kind: 'external', reason: 'password' | 'unsupported' }
    | { kind: 'file', data: Uint8Array }

export async function downloadProtonModule(url: string, options: {
    signal?: AbortSignal,
    onProgress?: (downloaded: number, total?: number) => void,
} = {}): Promise<ProtonModuleResult> {
    if (findSingleProtonLink(url) !== url) throw new Error('Invalid Proton share URL')
    const { createProtonDriveClient } = await import('./protonDriveClient')
    options.signal?.throwIfAborted()
    const client = createProtonDriveClient(options.signal)
    const info = await client.experimental.getURLAccessInfo(url)
    if (info.isCustomPasswordProtected) return { kind: 'external', reason: 'password' }
    if (info.isLegacy) return { kind: 'external', reason: 'unsupported' }
    const share = await client.experimental.authURLAccess(url, undefined, true)
    const root = await share.getRootNode()
    if (root.type !== 'file' || !root.name.ok || !root.name.value.toLowerCase().endsWith('.risum')) {
        return { kind: 'external', reason: 'unsupported' }
    }
    const downloader = await share.getFileDownloader(root.uid, options.signal)
    const total = downloader.getClaimedSizeInBytes()
    const chunks: Uint8Array[] = []
    let bytes = 0
    options.onProgress?.(0, total)
    const controller = downloader.downloadToStream(new WritableStream<Uint8Array>({
        write(chunk) {
            options.signal?.throwIfAborted()
            chunks.push(chunk)
            bytes += chunk.byteLength
            options.onProgress?.(bytes, total)
        },
    }))
    // Never pass unverified or incomplete data to the module importer.
    await controller.completion()
    options.signal?.throwIfAborted()
    const data = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
    return { kind: 'file', data }
}
