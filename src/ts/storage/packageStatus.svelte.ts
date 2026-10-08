import { forageStorage } from 'src/ts/globalApi.svelte'
import { isNodeServer } from 'src/ts/platform'

export type CharacterPackageState = { package: boolean; assets: boolean; retired?: number }
export type ModulePackageState = { enabled: boolean; copied: number; failed: number; retired?: number }

// Server-side storage layout per character and module (V3 folders, V4 retired assets).
export const packageStatus = $state({
    loaded: false,
    characters: {} as Record<string, CharacterPackageState>,
    modules: {} as Record<string, ModulePackageState>,
})

let pending: Promise<void> | null = null

export function refreshPackageStatus(): Promise<void> {
    if (!isNodeServer) return Promise.resolve()
    pending ??= (async () => {
        try {
            await forageStorage.Init()
            const overview = await forageStorage.realStorage.storagePackageOverview()
            packageStatus.characters = overview?.characters ?? {}
            packageStatus.modules = overview?.modules ?? {}
            packageStatus.loaded = true
        } catch {
            // Badges are informational; a failed refresh keeps the last known state.
        } finally {
            pending = null
        }
    })()
    return pending
}

export type PackageLabel = '' | 'V3' | 'V3 일부' | 'V4'

export function characterPackageLabel(id: string): PackageLabel {
    const state = packageStatus.characters[id]
    if (!state) return ''
    if ((state.retired ?? 0) > 0) return 'V4'
    if (state.package) return 'V3'
    return state.assets ? 'V3 일부' : ''
}

export function modulePackageLabel(id: string): '' | '폴더' | 'V4' {
    const state = packageStatus.modules[id]
    if (!state) return ''
    if ((state.retired ?? 0) > 0) return 'V4'
    return state.enabled ? '폴더' : ''
}
