import { expect, it } from 'vitest'
const { planCharacterPackage } = require('./character-package-plan.cjs')

it('plans exclusive wiki/module/persona roots while retaining global references and stable IDs', () => {
    const resources = [
        { kind: 'wiki', id: 'wiki-a', chatId: 'chat-a', ownership: 'character-exclusive', ownerCharacterId: 'character-a' },
        { kind: 'module', id: 'module-a', ownership: 'character-exclusive', ownerCharacterId: 'character-a' },
        { kind: 'persona', id: 'persona-a', ownership: 'character-exclusive', ownerCharacterId: 'character-a' },
        { kind: 'module', id: 'shared', ownership: 'shared' },
        { kind: 'persona', id: 'unknown' },
        { kind: 'wiki', id: 'other', ownership: 'character-exclusive', ownerCharacterId: 'character-b' },
    ]
    const before = JSON.stringify(resources)
    const plan = planCharacterPackage('character-a', 'Tanya (2)', resources)
    expect(plan.active).toBe(false)
    expect(plan.manifest).toBe('characters/Tanya (2)/package.json')
    expect(plan.owned.map(entry => entry.root)).toEqual(['characters/Tanya (2)/wiki/chat-a', 'characters/Tanya (2)/modules', 'characters/Tanya (2)/personas'])
    expect(plan.owned.map(entry => entry.id)).toEqual(['wiki-a', 'module-a', 'persona-a'])
    expect(plan.globalRefs.map(entry => entry.id)).toEqual(['shared', 'unknown'])
    expect(plan.externalCharacterRefs).toEqual([{ kind: 'wiki', id: 'other', ownerCharacterId: 'character-b' }])
    expect(JSON.stringify(resources)).toBe(before)
})
it('rejects unsafe mapped segments, duplicate references and unknown resource kinds', () => {
    expect(() => planCharacterPackage('id', '../Tanya', [])).toThrow()
    expect(() => planCharacterPackage('id', 'Tanya', [{ id: 'x', kind: 'script' }])).toThrow()
    expect(() => planCharacterPackage('id', 'Tanya', [{ id: 'x', kind: 'wiki' }, { id: 'x', kind: 'wiki' }])).toThrow()
})
