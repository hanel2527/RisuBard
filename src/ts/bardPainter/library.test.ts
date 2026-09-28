import { describe, expect, it } from 'vitest'
import { copyPainterIdentity, copyPainterOutfit, filterPainterLoreLinks, getPainterLoreIdentity, outfitsForIdentity, withPainterLoreIdentity } from './library'
import { exportPainterBotData, normalizePainterBotData } from './painterCardData'

const identity = { id: 'aria', name: 'Aria', aliases: ['Captain'], appearance: 'black hair', outfitIds: ['shared', 'missing', 'other-owned'], defaultOutfitId: 'shared', attachToCard: true }
const outfit = { id: 'shared', subjectId: '', name: 'Uniform', clothing: 'school uniform', state: '', attachToCard: true }
const library = { identities: [identity], outfits: [outfit,
    { ...outfit, id: 'legacy', subjectId: 'aria' },
    { ...outfit, id: 'other-owned', subjectId: 'other' },
] }

describe('painter library copies', () => {
    it('selects linked shared templates and legacy owned outfits, never another identity outfit', () => {
        expect(outfitsForIdentity(library, 'aria').map(item => item.id)).toEqual(['shared', 'legacy'])
        expect(outfitsForIdentity(library, 'missing')).toEqual([])
    })
    it('copies a character and its outfits with fresh IDs and remapped defaults, without export consent', () => {
        const before = JSON.stringify(library)
        const copy = copyPainterIdentity(library, 'aria', library)
        expect(copy.identity.id).not.toBe('aria')
        expect(copy.identity.name).toBe('Aria (2)')
        expect(copy.outfits).toHaveLength(2)
        expect(copy.outfits.every(item => !library.outfits.some(old => old.id === item.id))).toBe(true)
        expect(copy.outfits.map(item => item.subjectId)).toEqual(['', ''])
        expect(copy.identity.outfitIds).toEqual(copy.outfits.map(item => item.id))
        expect(copy.identity.defaultOutfitId).toBe(copy.outfits[0].id)
        expect(JSON.stringify(copy)).not.toContain('attachToCard')
        copy.identity.aliases.push('new')
        expect(JSON.stringify(library)).toBe(before)
    })
    it('copies an owned outfit as an independent template and avoids repeated names', () => {
        const copy = copyPainterOutfit(library.outfits[1], [outfit, { ...outfit, name: 'Uniform (2)' }])
        expect(copy).toMatchObject({ subjectId: '', name: 'Uniform (3)', clothing: 'school uniform' })
        expect(copy.id).not.toBe('legacy')
        expect(copy.attachToCard).toBeUndefined()
    })
    it('avoids names differing only in case or surrounding whitespace for characters and outfits', () => {
        const copy = copyPainterIdentity(library, 'aria', {
            identities: [{ ...identity, name: ' aria ' }, { ...identity, name: 'ARIA (2)' }], outfits: [],
        })
        expect(copy.identity.name).toBe('Aria (3)')
        expect(copyPainterOutfit({ ...outfit, name: ' Uniform ' }, [{ ...outfit, name: 'uniform' }]).name).toBe('Uniform (2)')
    })
})

describe('painter lore extension links', () => {
    it('updates and removes only the namespaced identity link immutably', () => {
        const entry = { content: 'Lore', extentions: { risu_case_sensitive: true, custom: 1, risubard: { other: 2, bardPainter: { unknown: 3 } } } }
        const linked = withPainterLoreIdentity(entry, 'aria')
        expect(getPainterLoreIdentity(linked)).toBe('aria')
        expect(getPainterLoreIdentity(entry)).toBeUndefined()
        expect(withPainterLoreIdentity(linked)).toEqual(entry)
        expect(filterPainterLoreLinks([linked], [identity])).toEqual([linked])
        expect(filterPainterLoreLinks([linked], [])).toEqual([entry])
    })
    it('tolerates malformed namespaces and strips malformed links while retaining unrelated data', () => {
        for (const risubard of [null, 'legacy', [], { bardPainter: null }]) {
            const entry = { extentions: { risubard } }
            expect(getPainterLoreIdentity(entry)).toBeUndefined()
            expect(filterPainterLoreLinks([entry], [])).toEqual([entry])
            expect(getPainterLoreIdentity(withPainterLoreIdentity(entry, 'aria'))).toBe('aria')
        }
        expect(filterPainterLoreLinks([{ extentions: { risubard: { bardPainter: { identityId: 7, keep: true } } } }], []))
            .toEqual([{ extentions: { risubard: { bardPainter: { keep: true } } } }])
    })
})

describe('painter card preset projection', () => {
    it('takes outfit links from the accepted identity instead of an earlier malformed duplicate', () => {
        const data = normalizePainterBotData({
            identities: [{ id: 'aria', name: null, appearance: 'invalid', outfitIds: [], defaultOutfitId: 'missing' }, identity,
                { ...identity, outfitIds: [], defaultOutfitId: 'missing' }],
            outfits: [outfit],
        })!
        expect(data.identities).toHaveLength(1)
        expect(data.identities[0]).toMatchObject({ name: 'Aria', outfitIds: ['shared'], defaultOutfitId: 'shared' })
    })
    it('normalizes modern shared outfits, removes missing links, and does not import consent', () => {
        const normalized = normalizePainterBotData(library)!
        expect(normalized.identities[0]).toMatchObject({ outfitIds: ['shared'], defaultOutfitId: 'shared' })
        expect(normalized.outfits.map(item => item.id)).toEqual(['shared', 'legacy'])
        expect(JSON.stringify(normalized)).not.toContain('attachToCard')
        expect(normalizePainterBotData({ ...library, identities: [{ ...identity, defaultOutfitId: 'missing' }] })!.identities[0].defaultOutfitId).toBeUndefined()
    })
    it('allows independently selected outfits without any character and filters private default links', () => {
        expect(exportPainterBotData({ identities: [], outfits: [outfit] })).toEqual({ identities: [], outfits: [{ id: 'shared', subjectId: '', name: 'Uniform', clothing: 'school uniform', state: '' }] })
        const projected = exportPainterBotData({ ...library, outfits: library.outfits.map(item => ({ ...item, attachToCard: false })) })!
        expect(projected.identities[0].outfitIds).toEqual([])
        expect(projected.identities[0].defaultOutfitId).toBeUndefined()
        expect(normalizePainterBotData({ outfits: [outfit] })?.outfits).toHaveLength(1)
    })
})
