export function isCanonicalFilesChangedResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false
    const response = value as Record<string, unknown>
    return response.canonicalFilesChanged === true
        || response.code === 'CANONICAL_FILES_CHANGED'
}

/** Files changed outside RisuBard while this tab holds state; the user must review them. */
export function isExternalChangesPendingResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false
    const response = value as Record<string, unknown>
    return response.externalChangesPending === true
        || response.code === 'EXTERNAL_CHANGES_PENDING'
}
