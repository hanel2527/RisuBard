export interface WikiRetrievalLimits { candidates: number; directSeeds: number }

/** Local search breadth, independent from final document/token budgets. */
export function normalizeWikiRetrievalLimits(value?: Partial<WikiRetrievalLimits>): WikiRetrievalLimits {
    const candidates = Number.isSafeInteger(value?.candidates)
        ? Math.max(1, Math.min(256, value!.candidates!)) : 64
    const directSeeds = Number.isSafeInteger(value?.directSeeds)
        ? Math.max(1, Math.min(128, candidates, value!.directSeeds!)) : Math.min(32, candidates)
    return { candidates, directSeeds }
}
