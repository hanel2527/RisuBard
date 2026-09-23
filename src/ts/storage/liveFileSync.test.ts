import { describe, expect, it } from 'vitest'
import { applyLiveFileSnapshot, createLiveFileRefresh } from './liveFileSync'

describe('live file refresh serialization', () => {
    it('waits for an ongoing save and serializes simultaneous preflight and polling refreshes', async () => {
        let finishSave!: () => void
        let inFlight: Promise<void> | null = new Promise(resolve => { finishSave = resolve })
        const calls: string[] = []
        let finishFirst!: () => void
        const first = new Promise<void>(resolve => { finishFirst = resolve })
        const refresh = createLiveFileRefresh({
            getInFlight: () => inFlight, setInFlight: value => { inFlight = value }, isActive: () => true,
            sync: async () => { calls.push('sync'); if (calls.length === 1) await first },
        })
        const poll = refresh()
        const send = refresh()
        expect(calls).toEqual([])
        const pendingSave = inFlight
        inFlight = null
        finishSave()
        await pendingSave
        await Promise.resolve()
        expect(calls).toEqual(['sync'])
        finishFirst()
        await Promise.all([poll, send])
        expect(calls).toEqual(['sync', 'sync'])
        expect(inFlight).toBeNull()
    })

    it('retries after a rejected operation and never syncs a retired runtime', async () => {
        let active = true
        let inFlight: Promise<void> | null = null
        let calls = 0
        const refresh = createLiveFileRefresh({
            getInFlight: () => inFlight, setInFlight: value => { inFlight = value }, isActive: () => active,
            sync: async () => { if (++calls === 1) throw new Error('invalid JSON') },
        })
        await expect(refresh()).rejects.toThrow('invalid JSON')
        await refresh()
        active = false
        await refresh()
        expect(calls).toBe(2)
        expect(inFlight).toBeNull()
    })
})

describe('live file metadata reconciliation', () => {
    it('preserves hydrated defaults absent from both canonical snapshots without putting them in the hash baseline', () => {
        const baseline = { characters: [{ chaId: 'a', desc: 'old' }], loreBook: [] }
        const current = { characters: [{ chaId: 'a', desc: 'old', emotionImages: [], globalLore: [], chats: [] }], loreBook: [] }
        applyLiveFileSnapshot(current, baseline, { characters: [{ chaId: 'a', desc: 'new' }], loreBook: [] })
        expect(current.characters[0]).toMatchObject({ desc: 'new', emotionImages: [], globalLore: [], chats: [] })
        expect(baseline.characters[0]).toEqual({ chaId: 'a', desc: 'new' })
    })
    it('applies external changes and deletions without replacing live chats or unrelated unsaved fields', () => {
        const chat = { id: 'chat', message: [{ data: 'streaming' }] }
        const baseline = { characters: [{ chaId: 'a', desc: 'old', name: 'old name', globalLore: [{ key: 'old' }], chats: [] }], loreBook: [] }
        const current = { characters: [{ ...baseline.characters[0], name: 'local name', chats: [chat], chatPage: 2 }], loreBook: [] }
        const character = current.characters[0]
        const result = applyLiveFileSnapshot(current, baseline, { characters: [{ chaId: 'a', desc: 'external', name: 'old name' }], loreBook: [] })
        expect(current.characters[0]).toBe(character)
        expect(character.chats[0]).toBe(chat)
        expect(character.chatPage).toBe(2)
        expect(character.desc).toBe('external')
        expect(character.name).toBe('local name')
        expect(character.globalLore).toEqual([])
        expect(baseline.characters[0]).not.toHaveProperty('globalLore')
        expect(result.conflicts).toEqual([])
        expect(baseline.characters[0].desc).toBe('external')
        expect(baseline.characters[0].name).toBe('old name')
    })

    it('keeps recoverable local values when the same field is externally replaced', () => {
        const baseline = { characters: [{ chaId: 'a', desc: 'old' }], loreBook: [] }
        const current = { characters: [{ chaId: 'a', desc: 'local' }], loreBook: [] }
        const result = applyLiveFileSnapshot(current, baseline, { characters: [{ chaId: 'a', desc: 'external' }], loreBook: [] })
        expect(current.characters[0].desc).toBe('external')
        expect(result.conflicts).toEqual([{ characterId: 'a', field: 'desc', localValue: 'local' }])
    })

    it('uses safe runtime defaults for removed required metadata without changing the raw baseline', () => {
        const baseline = { characters: [{ chaId: 'a', desc: 'old', name: 'old', additionalAssets: [['x']], emotionImages: [['happy']] }], loreBook: [] }
        const current = structuredClone(baseline)
        applyLiveFileSnapshot(current, baseline, { characters: [{ chaId: 'a' }], loreBook: [] })
        expect(current.characters[0]).toEqual({ chaId: 'a', desc: '', name: '', additionalAssets: [], emotionImages: [] })
        expect(baseline.characters[0]).toEqual({ chaId: 'a' })
    })

    it('does not revert local edits when the server field did not change, and applies root lore deletion', () => {
        const baseline = { characters: [{ chaId: 'a', desc: 'old' }], loreBook: [{ name: 'book' }] }
        const current = { characters: [{ chaId: 'a', desc: 'local' }], loreBook: [{ name: 'book' }] }
        applyLiveFileSnapshot(current, baseline, { characters: [{ chaId: 'a', desc: 'old' }], loreBook: [] })
        expect(current.characters[0].desc).toBe('local')
        expect(current.loreBook).toEqual([])
    })
})
