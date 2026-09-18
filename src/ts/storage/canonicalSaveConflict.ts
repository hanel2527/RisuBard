export type CanonicalConflictChoice = 'keep' | 'download' | 'cancel'

/** Unresolved conflicts must gate every attempt, including full-write retries. */
export function createCanonicalSaveConflict() {
    let pending = false
    return {
        mark() { pending = true },
        pending: () => pending,
        async resolve(
            choose: () => Promise<CanonicalConflictChoice>,
            keepLocal: () => Promise<void>,
            downloadLocal: () => Promise<void>,
        ): Promise<'retry' | 'noop'> {
            const choice = await choose()
            if (choice === 'keep') {
                await keepLocal()
                pending = false
                return 'retry'
            }
            if (choice === 'download') await downloadLocal()
            return 'noop'
        },
    }
}
