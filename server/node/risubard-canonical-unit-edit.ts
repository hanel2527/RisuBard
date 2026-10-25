import { isWikiHeadingLabel } from '../../src/ts/risubard/wikiWritingLanguage'
import { coverSupportsUnit, joinSectionUnits, splitSectionUnits } from './risubard-canonical-maintenance'
import {
    applyCanonicalSectionPatches,
    listCanonicalSections,
    mapCanonicalSectionBodies,
    normalizeCanonicalSectionHeading,
} from './risubard-markdown-section-patch'
import type { CanonicalSectionPatch } from './risubard-memory-writer'

// Existing sections are edited unit by unit so that whatever the model leaves
// out stays; only the current-state snapshot and new sections are written whole.
export const CANONICAL_UNIT_EDIT_INSTRUCTIONS = [
    'Existing sections show numbered units such as "- [3] text". The numbers are references only; never write them.',
    'To change an existing section other than the current-state section, use operation edit with empty content: put new units in add, rewritten units in replace with their index, and units to drop in remove with a reason. Units you do not mention stay unchanged, so never repeat them.',
    'Remove reasons: superseded when a confirmed change in this turn made the unit untrue; merged when its facts now live in the unit numbered mergedInto, which must stay; corrected when the confirmed messages show it was wrong. Set mergedInto only for merged. Prefer replace when a unit only needs new wording or a new value.',
    'For the current-state section and for a section that does not exist yet, use operation upsert with the complete body. Do not delete an existing section; remove its units with edit. Delete a section only when every fact in it appears in another section in the same response.',
    'Every section object has heading, operation, content, add, replace and remove. Use empty arrays for the fields an operation does not use.',
]

const UNIT_MARKER = /^(\s*(?:[-*]\s+)?)\[\d{1,4}\]\s+/gmu
const LINK = /\[\[([^\]|#]+)/gu

const normalized = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
const linksIn = (value: string) => new Set([...value.matchAll(LINK)].map((match) => match[1].trim()))

/** Unit references are shown to the model only; they never belong in saved text. */
export function stripUnitMarkers(value: string): string {
    return value.replace(UNIT_MARKER, '$1')
}

// A unit's own text, without a bullet or a copied reference number.
const unitText = (value: string) => stripUnitMarkers(value).trim().replace(/^[-*]\s+/u, '')

/** The document as the model sees it: every section's units numbered for edit references. */
export function annotateCanonicalUnits(markdown: string): string {
    try {
        return mapCanonicalSectionBodies(markdown, (_heading, body) => {
            const { bullet, units } = splitSectionUnits(body)
            return joinSectionUnits(units.map((unit, index) => `[${index}] ${unit}`), bullet)
        })
    }
    catch {
        return markdown
    }
}

export interface CanonicalUnitResolution {
    /** Only upsert and delete patches, ready for applyCanonicalSectionPatches. */
    patches: CanonicalSectionPatch[]
    /** Units dropped without a reason or support that were kept. */
    restored: number
    /** Unit edits ignored because their index or reason was not valid. */
    rejected: number
    /** Units removed with a valid reason. */
    removed: number
}

/**
 * Turns a model's section patches into saved text with preservation as the
 * default. Unit edits change only the units they name; a whole-section
 * rewrite or delete of an existing section keeps every old unit the result no
 * longer supports. The current-state snapshot is replaced by design, and a
 * rewrite target such as the story arc map may be compacted freely.
 */
export function resolveCanonicalUnitPatches(input: {
    markdown: string
    title: string
    patches: readonly CanonicalSectionPatch[]
    /** The turn recorded a state change, so a unit may be superseded on its own. */
    allowSupersede: boolean
    rewrite?: boolean
}): CanonicalUnitResolution {
    const existing = new Map(listCanonicalSections(input.markdown)
        .map((section) => [normalizeCanonicalSectionHeading(section.heading), section]))
    let restored = 0
    let rejected = 0
    let removed = 0
    const guarded = new Set<CanonicalSectionPatch>()
    const resolved: CanonicalSectionPatch[] = []
    for (const patch of input.patches) {
        const section = patch.heading ? existing.get(normalizeCanonicalSectionHeading(patch.heading)) : undefined
        if (patch.operation !== 'edit') {
            const next: CanonicalSectionPatch = {
                heading: patch.heading,
                operation: patch.operation,
                content: stripUnitMarkers(patch.content).trim(),
            }
            if (section && !input.rewrite && !isWikiHeadingLabel('currentState', patch.heading)) guarded.add(next)
            resolved.push(next)
            continue
        }
        const edits = patch.edits ?? { add: [], replace: [], remove: [] }
        const add = edits.add.map(unitText).filter(Boolean)
        if (!section) {
            if (add.length > 0) resolved.push({ heading: patch.heading, operation: 'upsert', content: joinSectionUnits(add, true) })
            rejected += edits.replace.length + edits.remove.length
            continue
        }
        const { bullet, units } = splitSectionUnits(section.body)
        const result = [...units]
        const replaced = new Set<number>()
        for (const item of edits.replace) {
            const text = unitText(item.text)
            if (item.index >= units.length || replaced.has(item.index) || !text) {
                rejected += 1
                continue
            }
            replaced.add(item.index)
            result[item.index] = text
        }
        const removals = new Map<number, (typeof edits.remove)[number]>()
        for (const item of edits.remove) {
            const target = item.mergedInto
            const validTarget = target !== null && target < units.length && target !== item.index
            const allowed = item.reason === 'merged' ? validTarget
                : item.reason === 'superseded' ? input.allowSupersede || validTarget
                    : true
            if (item.index >= units.length || replaced.has(item.index) || removals.has(item.index) || !allowed) {
                rejected += 1
                continue
            }
            removals.set(item.index, item)
        }
        // A unit merged into another removed unit would vanish with it.
        for (const [index, item] of [...removals]) {
            if (item.mergedInto !== null && removals.has(item.mergedInto)) {
                removals.delete(index)
                rejected += 1
            }
        }
        const kept = () => [...result.filter((_unit, index) => !removals.has(index)), ...add]
        const present = linksIn(kept().join('\n'))
        for (const index of [...removals.keys()]) {
            if ([...linksIn(units[index])].some((link) => !present.has(link))) {
                removals.delete(index)
                restored += 1
            }
        }
        removed += removals.size
        if (replaced.size === 0 && removals.size === 0 && add.length === 0) continue
        const final = kept()
        resolved.push(final.length === 0
            ? { heading: patch.heading, operation: 'delete', content: '' }
            : { heading: patch.heading, operation: 'upsert', content: joinSectionUnits(final, bullet || units.length === 0) })
    }
    if (guarded.size === 0) return { patches: resolved, restored, rejected, removed }
    let documentText: string
    try {
        documentText = applyCanonicalSectionPatches({ markdown: input.markdown, title: input.title, patches: resolved })
    }
    catch {
        // The caller applies the same patches and reports the structural error.
        return { patches: resolved, restored, rejected, removed }
    }
    const remaining = normalized(documentText)
    const supported = (unit: string) => remaining.includes(normalized(unit)) || coverSupportsUnit(unit, documentText)
    const patches = resolved.map((patch) => {
        if (!guarded.has(patch)) return patch
        const section = existing.get(normalizeCanonicalSectionHeading(patch.heading))!
        const { bullet, units } = splitSectionUnits(section.body)
        const missing = units.filter((unit) => !supported(unit))
        if (missing.length === 0) return patch
        restored += missing.length
        if (patch.operation === 'delete') {
            return { heading: patch.heading, operation: 'upsert' as const, content: joinSectionUnits(missing, bullet) }
        }
        const appendAsBullets = bullet || splitSectionUnits(patch.content).bullet
        return {
            ...patch,
            content: `${patch.content}${appendAsBullets ? '\n' : '\n\n'}${joinSectionUnits(missing, appendAsBullets)}`,
        }
    })
    return { patches, restored, rejected, removed }
}
