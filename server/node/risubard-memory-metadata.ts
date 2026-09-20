export interface MemoryStoryTime {
    day: number | null
    evidence: string
    precision: 'origin' | 'explicit' | 'unknown'
}

export interface MemoryRetrievalMetadata {
    keywords: string[]
    storyTime?: MemoryStoryTime
}

export interface SemanticTemporalHint {
    elapsedDays: number | null
    evidence: string
}

export interface MemoryTimelineEntry {
    day: number | null
    precision: MemoryStoryTime['precision']
}

const MAX_KEYWORDS = 24
const MAX_KEYWORD_LENGTH = 80

function requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`)
    }
    return value.trim()
}

export function normalizeMemoryRetrievalKeywords(value: unknown): string[] {
    if (!Array.isArray(value)) {
        throw new Error('Memory retrieval keywords must be an array')
    }
    const seen = new Set<string>()
    const keywords: string[] = []
    for (const valueItem of value) {
        const keyword = requiredString(valueItem, 'Memory retrieval keyword')
        if (keyword.length > MAX_KEYWORD_LENGTH) {
            throw new Error(`Memory retrieval keyword must contain 1-${MAX_KEYWORD_LENGTH} characters`)
        }
        const key = keyword.normalize('NFKC').toLocaleLowerCase()
        if (!seen.has(key) && keywords.length < MAX_KEYWORDS) {
            seen.add(key)
            keywords.push(keyword)
        }
    }
    return keywords
}

function normalizeStoryTime(value: unknown): MemoryStoryTime {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Memory story time must be an object')
    }
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== 3) {
        throw new Error('Memory story time has invalid fields')
    }
    const day = record.day
    if (day !== null && (typeof day !== 'number' || !Number.isSafeInteger(day) || day < 0)) {
        throw new Error('Memory story time day must be a non-negative integer or null')
    }
    const evidence = requiredString(record.evidence, 'Memory story time evidence')
    if (evidence.length > 240) {
        throw new Error('Memory story time evidence must contain 1-240 characters')
    }
    const precision = record.precision
    if (precision !== 'origin' && precision !== 'explicit' && precision !== 'unknown') {
        throw new Error('Memory story time precision is invalid')
    }
    if (precision === 'origin' && day !== 0) {
        throw new Error('Memory story time origin must be day zero')
    }
    if (precision === 'unknown' && day !== null) {
        throw new Error('Unknown memory story time must not retain a day')
    }
    if (precision === 'explicit' && day === null) {
        throw new Error('Explicit memory story time requires a day')
    }
    return { day: day as number | null, evidence, precision }
}

export function normalizeMemoryRetrievalMetadata(
    value: unknown
): MemoryRetrievalMetadata | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Memory retrieval metadata must be an object')
    }
    const record = value as Record<string, unknown>
    const allowed = new Set(['keywords', 'storyTime'])
    if (!Object.hasOwn(record, 'keywords')
        || Object.keys(record).some((key) => !allowed.has(key))) {
        throw new Error('Memory retrieval metadata has invalid fields')
    }
    return {
        keywords: normalizeMemoryRetrievalKeywords(record.keywords),
        ...(record.storyTime === undefined
            ? {}
            : { storyTime: normalizeStoryTime(record.storyTime) }),
    }
}

function immediatelyPriorDay(
    priorTimeline: readonly MemoryTimelineEntry[]
): number | undefined {
    const entry = priorTimeline.at(-1)
    return entry?.precision !== 'unknown' && entry?.day !== null
        && Number.isSafeInteger(entry.day) && entry.day >= 0
        ? entry.day
        : undefined
}

export function resolveMemoryRetrievalMetadata(input: {
    keywords: unknown
    temporalHint?: SemanticTemporalHint
    priorTimeline?: readonly MemoryTimelineEntry[]
}): MemoryRetrievalMetadata {
    const keywords = normalizeMemoryRetrievalKeywords(input.keywords)
    const priorTimeline = input.priorTimeline ?? []
    if (priorTimeline.length === 0) {
        return {
            keywords,
            storyTime: {
                day: 0,
                evidence: 'first recorded event',
                precision: 'origin',
            },
        }
    }
    const temporalHint = input.temporalHint
    if (!temporalHint || temporalHint.elapsedDays === null
        || !Number.isSafeInteger(temporalHint.elapsedDays)
        || temporalHint.elapsedDays < 0
        || typeof temporalHint.evidence !== 'string'
        || temporalHint.evidence.trim().length === 0) {
        return {
            keywords,
            storyTime: {
                day: null,
                evidence: 'no grounded elapsed time',
                precision: 'unknown',
            },
        }
    }
    const previousDay = immediatelyPriorDay(priorTimeline)
    if (previousDay === undefined) {
        return {
            keywords,
            storyTime: {
                day: null,
                evidence: 'no grounded prior story time',
                precision: 'unknown',
            },
        }
    }
    const day = previousDay + temporalHint.elapsedDays
    if (!Number.isSafeInteger(day)) {
        return {
            keywords,
            storyTime: {
                day: null,
                evidence: 'story time exceeds supported range',
                precision: 'unknown',
            },
        }
    }
    return {
        keywords,
        storyTime: {
            day,
            evidence: temporalHint.evidence.trim().slice(0, 240),
            precision: 'explicit',
        },
    }
}
