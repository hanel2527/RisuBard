// One chat's wiki analyses run strictly one after another: each analysis
// reads the documents, calls the model and saves with a content hash, so two
// overlapping runs for the same chat make the later save fail on a stale hash.
const chains = new Map<string, Promise<void>>()

export function enqueueNarrativeConfirmation<T>(
    key: string,
    task: () => Promise<T>,
): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve()
    const run = previous.then(task)
    const settled: Promise<void> = run.then(() => undefined, () => undefined)
    chains.set(key, settled)
    void settled.then(() => {
        if (chains.get(key) === settled) chains.delete(key)
    })
    return run
}

export function pendingNarrativeConfirmationKeys(): string[] {
    return [...chains.keys()]
}
