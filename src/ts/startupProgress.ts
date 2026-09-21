interface StartupProgress {
    text: string
    error: string
}

export async function advanceStartupStage(state: StartupProgress, label: string): Promise<void> {
    state.text = label
    state.error = ''
    // Let Svelte flush and the browser paint before synchronous decoding/setup.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
}

export function failStartupStage(state: StartupProgress, error: unknown): void {
    state.error = error instanceof Error ? error.message : String(error)
}
