import type { ExternalChangesPending } from './nodeStorage'

export type ExternalChangeDecision = 'accept' | 'keep'

/** Review dialog state for files edited outside RisuBard while it is open. */
export const externalChangeReview = $state<{
    pending: ExternalChangesPending | null
    busy: boolean
    error: string
}>({ pending: null, busy: false, error: '' })

let resolver: ((decision: ExternalChangeDecision | 'dismissed') => void) | null = null

/** Show the review dialog and wait until the user chooses. */
export function requestExternalChangeDecision(pending: ExternalChangesPending): Promise<ExternalChangeDecision | 'dismissed'> {
    externalChangeReview.pending = pending
    externalChangeReview.busy = false
    return new Promise(resolve => { resolver = resolve })
}

export function chooseExternalChangeDecision(decision: ExternalChangeDecision) {
    if (!resolver || externalChangeReview.busy) return
    externalChangeReview.busy = true
    externalChangeReview.error = ''
    const resolve = resolver
    resolver = null
    resolve(decision)
}

/** The files no longer differ (for example the edit was reverted): nothing to decide. */
export function dismissExternalChangeReview() {
    const resolve = resolver
    resolver = null
    resolve?.('dismissed')
}

export function closeExternalChangeReview() {
    externalChangeReview.pending = null
    externalChangeReview.busy = false
    externalChangeReview.error = ''
}
