import { fingerprintBardLoreEntry, type BardLoreAtomCandidate, type BardLoreEntry } from './bardLore'
import { applyBardLoreAnalysisDraft, type BardLoreAnalysisApplyResult } from './bardLoreAnalysis'
import { bardLoreListKind, inspectBardLoreList } from './bardLoreListStructure'
export { assessBardLoreBulkRisk } from './bardLoreListStructure'

export interface BardLoreLocalSplitPreview {
    sourceId: string
    sourceHash: string
    atoms: BardLoreAtomCandidate[]
    contexts: BardLoreAtomCandidate[]
    contextByAtom: string[][]
    unassigned: string
    canApply: boolean
    reason?: 'already-split' | 'unsupported' | 'unassigned' | 'inactive'
}

export function previewBardLoreLocalSplit(source: BardLoreEntry, entries: BardLoreEntry[] = []): BardLoreLocalSplitPreview {
    const { parts, unassigned } = inspectBardLoreList(source)
    const kind = bardLoreListKind(source)
    const atoms = parts.map((part): BardLoreAtomCandidate => ({
        name: part.name, content: part.content, aliases: part.aliases, kind,
        tags: [kind], summary: part.name, facets: [], links: [],
    }))
    const contexts = [...new Set(parts.flatMap(part => part.context))].map((content): BardLoreAtomCandidate => ({
        name: `${source.comment} / ${content.replace(/^#+\s/u, '')}`, content,
        aliases: [], kind: 'other', tags: ['source-context'], summary: content.replace(/^#+\s/u, ''), facets: [], links: [],
    }))
    const reason = entries.some(entry => entry.bard.derivedFromId === source.id) ? 'already-split'
        : source.enabled === false || source.bard.activation === 'never' ? 'inactive'
        : atoms.length < 2 ? 'unsupported'
        : unassigned ? 'unassigned' : undefined
    return { sourceId: source.id, sourceHash: fingerprintBardLoreEntry(source), atoms, contexts,
        contextByAtom: parts.map(part => part.context), unassigned, canApply: !reason, reason }
}

export function applyBardLoreLocalSplit(entries: BardLoreEntry[], preview: BardLoreLocalSplitPreview): BardLoreAnalysisApplyResult {
    const source = entries.find(entry => entry.id === preview.sourceId)
    if (!source || fingerprintBardLoreEntry(source) !== preview.sourceHash) {
        return { entries, appliedIds: [], conflicts: [{ id: preview.sourceId, reason: source ? 'source-changed' : 'missing-entry' }] }
    }
    // Rebuild from the current source rather than trusting mutable preview data.
    const verified = previewBardLoreLocalSplit(source, entries)
    if (!verified.canApply) return { entries, appliedIds: [], conflicts: [] }
    const result = applyBardLoreAnalysisDraft(entries, { entries: [{
        id: source.id, sourceHash: preview.sourceHash, kind: source.bard.kind,
        activation: 'retrieve', injection: 'index-only', aliases: [], tags: ['list'],
        summary: source.comment, facets: [], links: [], atoms: [...verified.atoms, ...verified.contexts],
    }] }, { overwriteExisting: false })
    const existingIds = new Set(entries.map(entry => entry.id))
    for (const entry of result.entries) {
        if (!existingIds.has(entry.id) && entry.bard.derivedFromId === source.id) {
            const atomIndex = verified.atoms.findIndex(atom => atom.name === entry.comment && atom.content === entry.content)
            // Context headings travel only through the explicitly scoped links.
            entry.bard.activation = atomIndex >= 0 ? 'retrieve' : 'keyed'
            entry.folder = source.folder
            if (atomIndex >= 0) entry.bard.links = verified.contextByAtom[atomIndex].flatMap(content => {
                const context = result.entries.find(item => item.bard.derivedFromId === source.id
                    && item.bard.tags.includes('source-context') && item.content === content)
                return context ? [{ targetId: context.id, relation: 'source-context', retrieval: 'supporting' as const }] : []
            })
        }
    }
    return result
}
