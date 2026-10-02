import { expect, test } from 'vitest'
import { applyPatch } from 'fast-json-patch'
const { calculateHash, createCachedHash, copyPatchPaths } = require('./utils.cjs')

const database = () => ({
    loreBook: [{ key: 'a', content: '가나다' }],
    characters: [{ chaId: '1', name: 'One', list: [1, 2.5, null] }, { chaId: '2', flag: true }],
})

test('cached patch hashes match the protocol hash across patched versions', () => {
    const hash = createCachedHash()
    let current = database()
    expect(hash(current)).toBe(calculateHash(current))
    const patches = [
        [{ op: 'replace', path: '/characters/1/flag', value: false }],
        [{ op: 'add', path: '/characters/0/list/-', value: { nested: 'x' } }],
        [{ op: 'move', from: '/loreBook/0', path: '/characters/1/moved' }],
    ]
    for (const patch of patches) {
        const next = copyPatchPaths(current, patch)
        applyPatch(next, patch, true)
        expect(hash(next)).toBe(calculateHash(JSON.parse(JSON.stringify(next))))
        expect(hash(current)).toBe(calculateHash(JSON.parse(JSON.stringify(current))))
        current = next
    }
})

test('a failed patch leaves the original database untouched', () => {
    const original = database()
    const before = JSON.stringify(original)
    const patch = [
        { op: 'replace', path: '/characters/0/name', value: 'Changed' },
        { op: 'remove', path: '/missing/value' },
    ]
    expect(() => applyPatch(copyPatchPaths(original, patch), patch, true)).toThrow()
    expect(JSON.stringify(original)).toBe(before)
})
