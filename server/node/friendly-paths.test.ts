import { expect, it } from 'vitest'
const { sanitizeSegment, allocateSegment, planDirectoryMapping } = require('./friendly-paths.cjs')

it('normalizes portable segments, reserved devices and empty names within a UTF-8 byte limit', () => {
    expect(sanitizeSegment('  A<>:"/\\|?*\u0001. ')).toBe('A__________')
    expect(sanitizeSegment('CON.txt')).toBe('_CON.txt')
    expect(sanitizeSegment('aux')).toBe('_aux')
    expect(sanitizeSegment('...')).toBe('Untitled')
    expect(sanitizeSegment('')).toBe('Untitled')
    expect(sanitizeSegment('e\u0301')).toBe('é')
    expect(Buffer.byteLength(sanitizeSegment('가'.repeat(200)))).toBeLessThanOrEqual(120)
})
it('numbers Unicode and case-insensitive collisions and preserves the extension', () => {
    const taken = new Set(['photo.png', 'photo (2).png'])
    expect(allocateSegment('Photo.png', taken, true)).toBe('Photo (3).png')
    expect(allocateSegment('é', new Set(['e\u0301']))).toBe('é (2)')
    expect(allocateSegment('Name', new Set(['Name', 'NAME (2)']))).toBe('Name (3)')
    expect(Buffer.byteLength(allocateSegment('가'.repeat(200) + '.png', new Set(), true))).toBeLessThanOrEqual(120)
})
it('plans one opt-in character and duplicate chat names without changing IDs or activating paths', () => {
    const character = { chaId: 'id-one', name: 'Tanya', chats: [{ id: 'chat-a', name: 'Talk' }, { id: 'chat-b', name: 'talk' }] }
    const before = JSON.stringify(character)
    expect(planDirectoryMapping(character, ['Tanya', 'TANYA (2)'])).toEqual({ schemaVersion: 1, active: false, id: 'id-one', directory: 'Tanya (3)', chats: [{ id: 'chat-a', directory: 'Talk' }, { id: 'chat-b', directory: 'talk (2)' }] })
    expect(JSON.stringify(character)).toBe(before)
    expect(() => planDirectoryMapping({ ...character, chats: [character.chats[0], character.chats[0]] })).toThrow()
})
