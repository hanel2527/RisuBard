import { describe, expect, it } from 'vitest'
import type { loreBook } from '../storage/database.svelte'
import { createBardLoreSettings, fingerprintLegacyLore, normalizeBardLoreState, upgradeLegacyLorebook } from './bardLore'

const settings = createBardLoreSettings({
    targetTokens: 321,
    maximumTokens: 654,
    maxEntries: 7,
    contextMessages: 4,
})

function lore(overrides: Partial<loreBook> = {}): loreBook {
    return {
        key: '',
        secondkey: '',
        insertorder: 10,
        comment: 'Entry',
        content: 'Original content',
        mode: 'normal',
        alwaysActive: false,
        selective: false,
        ...overrides,
    }
}

describe('upgradeLegacyLorebook', () => {
    it('copies every legacy field without mutating the legacy source', () => {
        const original = lore({
            id: 'legacy-1',
            key: '폴로니안 몰, 시내',
            secondkey: '데이트',
            alwaysActive: true,
            activationPercent: 73,
            bookVersion: 4,
            useRegex: true,
            extentions: { risu_case_sensitive: true },
        })
        const snapshot = structuredClone(original)

        const state = upgradeLegacyLorebook([original], () => 'unused', settings)

        expect(original).toEqual(snapshot)
        expect(state.mode).toBe('bard')
        expect(state.settings).toEqual(settings)
        expect(state.entries[0]).toMatchObject(snapshot)
        expect(state.entries[0]).not.toBe(original)
        expect(state.entries[0].bard).toMatchObject({
            sourceLegacyId: 'legacy-1',
            activation: 'keyed',
            aliases: ['폴로니안 몰', '시내', '데이트'],
        })
    })

    it('does not promote an unkeyed always-active prose entry to required', () => {
        const state = upgradeLegacyLorebook([
            lore({ id: 'world', alwaysActive: true, comment: 'World history' }),
        ], () => 'unused', settings)

        expect(state.entries[0].bard.activation).toBe('retrieve')
    })

    it('disables folders, child links, and explicitly disabled entries', () => {
        const state = upgradeLegacyLorebook([
            lore({ id: 'folder', mode: 'folder' }),
            lore({ id: 'child', mode: 'child' }),
            lore({ id: 'disabled', enabled: false, key: 'key' }),
        ], () => 'unused', settings)

        expect(state.entries.map((entry) => entry.bard.activation)).toEqual(['never', 'never', 'never'])
    })

    it('assigns collision-safe IDs to missing and duplicate legacy IDs', () => {
        const generated = ['generated-1', 'generated-2']
        const state = upgradeLegacyLorebook([
            lore({ id: 'kept' }),
            lore({ id: 'kept' }),
            lore(),
        ], () => generated.shift()!, settings)

        expect(state.entries.map((entry) => entry.id)).toEqual(['kept', 'generated-1', 'generated-2'])
        expect(state.entries.map((entry) => entry.bard.sourceLegacyId)).toEqual(['kept', 'generated-1', 'generated-2'])
    })

    it('normalizes every retrieval and analysis tuning value into persisted soft settings', () => {
        const normalized = createBardLoreSettings({
            targetTokens: -1,
            maximumTokens: 900,
            maxEntries: 0,
            contextMessages: 0,
            maxLinkDepth: 3,
            minimumSparseScore: 2.5,
            directMatchScore: 75,
            linkScore: 50,
            linkScoreDecay: 0.4,
            minimumTermLength: 3,
            cjkPartialMatching: false,
            fieldWeights: {
                name: 1,
                keys: 2,
                aliases: 3,
                tags: 4,
                summary: 5,
                content: 0,
            },
            analysisBatchEntries: 9,
            analysisInputTokens: 12_000,
            analysisOutputTokens: 2_000,
            analysisLinkedDepth: 2,
            analysisTemperature: 0.35,
        })

        expect(normalized).toMatchObject({
            targetTokens: 0,
            maximumTokens: 900,
            maxEntries: 0,
            contextMessages: 0,
            maxLinkDepth: 3,
            minimumSparseScore: 2.5,
            directMatchScore: 75,
            linkScore: 50,
            linkScoreDecay: 0.4,
            minimumTermLength: 3,
            cjkPartialMatching: false,
            fieldWeights: { content: 0 },
            analysisBatchEntries: 9,
            analysisInputTokens: 12_000,
            analysisOutputTokens: 2_000,
            analysisLinkedDepth: 2,
            analysisTemperature: 0.35,
        })
    })

    it('normalizes empty and duplicate metadata terms at the storage boundary', () => {
        const state = upgradeLegacyLorebook([lore({ id: 'entry' })], () => 'unused', settings)
        state.entries[0].bard.aliases = ['', '  ', ' 탑 ', '탑']
        state.entries[0].bard.tags = ['', ' 장소 ', '장소']

        const normalized = normalizeBardLoreState(state)

        expect(normalized?.entries[0].bard.aliases).toEqual(['탑'])
        expect(normalized?.entries[0].bard.tags).toEqual(['장소'])
    })

    it('loads existing schema-version-1 entries with empty structured routing metadata', () => {
        const state = upgradeLegacyLorebook([lore({ id: 'entry' })], () => 'unused', settings)
        const legacyMetadata = state.entries[0].bard as unknown as Record<string, unknown>
        delete legacyMetadata.facets
        delete legacyMetadata.injection

        const normalized = normalizeBardLoreState(state)

        expect(normalized?.entries[0].bard.facets).toEqual([])
        expect(normalized?.entries[0].bard.injection).toBe('full')
    })

    it('normalizes facets, expanded relation policies, and soft router settings', () => {
        const state = upgradeLegacyLorebook([lore({ id: 'entry' }), lore({ id: 'school' })], () => 'unused', settings)
        state.entries[0].bard.facets = [
            { key: ' gender ', value: ' male ', aliases: ['', ' 남자 ', '남자'] },
        ]
        state.entries[0].bard.injection = 'index-only'
        state.entries[0].bard.links = [{ targetId: 'school', relation: ' attends ', retrieval: 'ambient' }]
        state.settings.router = {
            ...state.settings.router,
            defaultResultCount: 7,
            ambientResultCount: 4,
            kindAliases: {
                ...state.settings.router.kindAliases,
                character: ['', ' 인물 ', '인물'],
            },
        }

        const normalized = normalizeBardLoreState(state)

        expect(normalized?.entries[0].bard).toMatchObject({
            injection: 'index-only',
            facets: [{ key: 'gender', value: 'male', aliases: ['남자'] }],
            links: [{ targetId: 'school', relation: 'attends', retrieval: 'ambient' }],
        })
        expect(normalized?.settings.router).toMatchObject({
            defaultResultCount: 7,
            ambientResultCount: 4,
            kindAliases: { character: ['인물'] },
        })
    })

    it('rejects a persisted Bard Lore state with duplicate entry IDs', () => {
        const state = upgradeLegacyLorebook([lore({ id: 'first' }), lore({ id: 'second' })], () => 'unused', settings)
        state.entries[1].id = state.entries[0].id

        expect(normalizeBardLoreState(state)).toBeUndefined()
    })

    it('restores completed analysis drafts and pauses interrupted work without rejecting lore entries', () => {
        const state = upgradeLegacyLorebook([lore({ id: 'entry' })], () => 'unused', settings)
        state.analysisRun = {
            schemaVersion: 1,
            id: 'run',
            scope: 'all',
            targetIds: ['entry'],
            createdAt: '2026-08-31T00:00:00.000Z',
            updatedAt: '2026-08-31T00:00:00.000Z',
            status: 'running',
            settingsSnapshot: settings,
            overwriteExisting: false,
            batches: [{
                id: 'batch',
                index: 0,
                targetIds: ['entry'],
                estimatedInputTokens: 40,
                status: 'running',
            }],
        }

        const normalized = normalizeBardLoreState(state)

        expect(normalized?.analysisRun?.status).toBe('paused')
        expect(normalized?.analysisRun?.languageSnapshot).toBeUndefined()
        expect(normalized?.analysisRun?.batches[0].status).toBe('pending')
        ;(state.analysisRun as unknown as Record<string, unknown>).batches = 'malformed'
        const withoutBadRun = normalizeBardLoreState(state)
        expect(withoutBadRun?.entries).toHaveLength(1)
        expect(withoutBadRun?.analysisRun).toBeUndefined()
    })

    it('falls back from non-finite saved settings instead of propagating them', () => {
        const normalized = createBardLoreSettings({
            contextMessages: Number.NaN,
            analysisBatchEntries: Number.POSITIVE_INFINITY,
            analysisInputTokens: Number.NaN,
        })

        expect(normalized.contextMessages).toBeGreaterThan(0)
        expect(normalized.analysisBatchEntries).toBeGreaterThan(0)
        expect(normalized.analysisInputTokens).toBeGreaterThan(0)
    })

    it('fingerprints source content deterministically and notices meaningful changes', () => {
        const source = lore({ id: 'entry', content: 'one' })

        expect(fingerprintLegacyLore(source)).toBe(fingerprintLegacyLore({ ...source }))
        expect(fingerprintLegacyLore(source)).not.toBe(fingerprintLegacyLore({ ...source, content: 'two' }))
    })
})
