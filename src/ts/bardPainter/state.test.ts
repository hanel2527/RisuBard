import { expect, it } from 'vitest'
import { reconcilePainterSubjects, capturePainterOutfit, promotePainterOutfit } from './state'
import type { PainterSubject } from './types'
const subject = (patch: Partial<PainterSubject> = {}): PainterSubject => ({ id: '', name: '아리아', aliases: [], kind: 'character', appearance: 'black hair', clothing: 'white shirt', state: 'wet clothes', pose: 'sitting', negative: '', ...patch })
it('resolves a known alias to the same identity without overwriting its stored appearance', () => {
    const bot = { identities: [{ id: 'aria', name: '아리아', aliases: ['Aria'], appearance: 'blue eyes' }], outfits: [] }
    const result = reconcilePainterSubjects([subject({ name: 'Aria' })], bot, [])
    expect(result[0].id).toBe('aria')
    expect(bot.identities[0].appearance).toBe('blue eyes')
})
it('keeps locked subject edits when a new prompt is prepared', () => {
    const locked = subject({ id: 'aria', clothing: 'red coat', locked: true })
    const bot = { identities: [{ id: 'aria', name: '아리아', aliases: [], appearance: '' }], outfits: [] }
    expect(reconcilePainterSubjects([subject({ id: 'aria' })], bot, [locked])[0]).toEqual(locked)
})
it('retains omitted locked blocks at their prior positions without retaining omitted unlocked blocks', () => {
    const locked = subject({ id: 'aria', clothing: 'red coat', locked: true })
    const omitted = subject({ id: 'luke', name: '루크' })
    const returned = subject({ id: 'mira', name: '미라' })
    const bot = { identities: [locked, omitted, returned].map(({ id, name, aliases }) => ({ id, name, aliases, appearance: '' })), outfits: [] }
    const result = reconcilePainterSubjects([returned], bot, [locked, omitted, returned])
    expect(result.map(item => item.id)).toEqual(['aria', 'mira'])
    expect(result[0]).toEqual(locked)
    result[0].aliases.push('changed')
    expect(locked.aliases).toEqual([])
})
it.each(['manual-aria', ''])('retains a manually added identity before allocating another ID (%s)', id => {
    const previous = subject({ id: 'manual-aria', aliases: ['Aria'] })
    const outfit = capturePainterOutfit(previous, '여행복', false)
    const bot = { identities: [], outfits: [outfit] }
    const [result] = reconcilePainterSubjects([subject({ id, name: 'Aria' })], bot, [previous])
    expect(result.id).toBe('manual-aria')
    expect(bot.outfits[0].subjectId).toBe(result.id)
    expect(bot.identities).toEqual([{ id: 'manual-aria', name: '아리아', aliases: ['Aria'], appearance: '' }])
})
it('does not replace registered identity appearance when a previous edited block is reconciled', () => {
    const previous = subject({ id: 'aria', appearance: 'red hair' })
    const bot = { identities: [{ id: 'aria', name: '아리아', aliases: [], appearance: 'blue hair' }], outfits: [] }
    reconcilePainterSubjects([subject({ id: 'aria', appearance: 'green hair' })], bot, [previous])
    expect(bot.identities).toEqual([{ id: 'aria', name: '아리아', aliases: [], appearance: 'blue hair' }])
})
it('rejects a merged draft above 22 subjects without dropping locks or changing stored identities', () => {
    const locked = subject({ id: 'locked', name: '보존할 인물', locked: true })
    const bot = { identities: [], outfits: [] }
    const generated = Array.from({ length: 22 }, (_, index) => subject({ name: `new-${index}` }))
    expect(() => reconcilePainterSubjects(generated, bot, [locked])).toThrow()
    expect(bot.identities).toEqual([])
})
it('saves clothing without pose, appearance or transient state by default', () => {
    const outfit = capturePainterOutfit(subject({ id: 'aria' }), '여행복', false)
    expect(outfit).toMatchObject({ subjectId: 'aria', name: '여행복', clothing: 'white shirt', state: '' })
    expect(outfit).not.toHaveProperty('pose')
    expect(outfit).not.toHaveProperty('appearance')
})
it('promotion copies a chat outfit to a separately editable bot outfit', () => {
    const original = capturePainterOutfit(subject({ id: 'aria' }), '여행복', true)
    const promoted = promotePainterOutfit(original)
    expect(promoted.id).not.toBe(original.id)
    promoted.clothing = 'black dress'
    expect(original.clothing).toBe('white shirt')
})
