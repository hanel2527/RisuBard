import { describe, expect, it } from 'vitest'
import { applyMaterializedBardLoreEntries, createBardLoreEntry, createBardLoreSettings, materializeBardLoreEntries, upgradeLegacyLorebook } from './bardLore'
import { applyBardLoreLocalSplit, previewBardLoreLocalSplit, assessBardLoreBulkRisk } from './bardLoreLocalSplit'
import { selectBardLoreEntries } from './bardLoreRetrieval'

function source(content: string, comment = 'npc list') {
    return createBardLoreEntry({ id: 'list', comment, content, key: '', secondkey: '', mode: 'normal', insertorder: 10, alwaysActive: true, selective: false })
}
const roster = '### NPC list\r\n- Format: Name/Alias (Gender)\r\n#### Hogwarts\r\n- Alice/앨리스 (Female):\r\n- Hair: Silver.\r\n- Personality: Patient.\r\n\r\n- Bob/밥 (Male)\r\n  - dress and hair: Blue cloak.\r\n'

describe('local Grimoire lists', () => {
    it('keeps attributes and CRLF in exact character slices and extracts only explicit names', () => {
        const entry = source(roster)
        const preview = previewBardLoreLocalSplit(entry)
        expect(preview.atoms.map(atom => atom.name)).toEqual(['Alice', 'Bob'])
        expect(preview.atoms[0].aliases).toEqual(['Alice', '앨리스'])
        expect(preview.atoms[0].content).toContain('- Hair: Silver.\r\n- Personality: Patient.')
        expect(preview.atoms[1].content).toContain('dress and hair: Blue cloak.')
        expect(preview.atoms.every(atom => roster.includes(atom.content))).toBe(true)
        expect(preview.atoms[0].kind).toBe('character')
        expect(preview.unassigned).toBe('')
        expect(preview.canApply).toBe(true)
    })

    it.each([['faction list', 'faction'], ['item list', 'item']])('splits %s without inferring relationships', (title, kind) => {
        const preview = previewBardLoreLocalSplit(source('- Silver Guild: Merchants.\n- Blue Order: Scholars.', title))
        expect(preview.atoms.map(atom => atom.name)).toEqual(['Silver Guild', 'Blue Order'])
        expect(preview.atoms.every(atom => atom.kind === kind && atom.links.length === 0)).toBe(true)
        expect(preview.canApply).toBe(true)
    })

    it('supports named leaf headings without splitting attribute headings', () => {
        const preview = previewBardLoreLocalSplit(source('## Item list\n### Moon blade\nA silver sword.\n### Sun shield\nA golden shield.', 'item list'))
        expect(preview.atoms.map(atom => atom.name)).toEqual(['Moon blade', 'Sun shield'])
        expect(preview.canApply).toBe(true)
    })

    it('does not silently discard shared prose or guess prose-only boundaries', () => {
        const preview = previewBardLoreLocalSplit(source('All guilds answer to the crown.\n- Silver Guild: Merchants.\n- Blue Order: Scholars.', 'faction list'))
        expect(preview.unassigned).toContain('answer to the crown')
        expect(preview.canApply).toBe(false)
        expect(previewBardLoreLocalSplit(source('Alice knows Bob. Bob knows Alice.')).canApply).toBe(false)
    })

    it('ignores property bullets in output estimates but excludes large lists even with a huge output allowance', () => {
        const single = source('- Alice/앨리스 (Female):\n' + '- Hair: silver\n'.repeat(100))
        expect(assessBardLoreBulkRisk(single, 60_000)).toBeNull()
        const big = source(Array.from({ length: 40 }, (_, i) => `- Person ${i}/인물 ${i} (Female): A wizard.`).join('\n'))
        expect(assessBardLoreBulkRisk(big, 60_000)?.itemCount).toBe(40)
        expect(assessBardLoreBulkRisk(big, 60_000)?.estimatedOutputTokens).toBeGreaterThan(8192)
        expect(assessBardLoreBulkRisk(source(roster), 512)).not.toBeNull()
    })

    it('applies without changing legacy content, persists derived entries and retrieves one named character', () => {
        const entry = source(roster)
        const before = structuredClone(entry)
        const preview = previewBardLoreLocalSplit(entry)
        const result = applyBardLoreLocalSplit([entry], preview)
        expect(result.conflicts).toEqual([])
        expect(entry).toEqual(before)
        expect(result.entries[0].content).toBe(roster)
        expect(result.entries[0].bard.injection).toBe('index-only')
        const atoms = result.entries.filter(item => item.bard.derivedFromId && item.bard.kind === 'character')
        expect(atoms).toHaveLength(2)
        expect(atoms.every(item => item.bard.activation === 'retrieve')).toBe(true)
        const state = upgradeLegacyLorebook([entry], () => 'generated', createBardLoreSettings())
        const saved = applyMaterializedBardLoreEntries(state, [entry], result.entries)
        expect(saved.legacyEntries[0].content).toBe(roster)
        expect(saved.legacyEntries).toHaveLength(1)
        const restored = materializeBardLoreEntries(JSON.parse(JSON.stringify(saved.state)), saved.legacyEntries)
        const selection = selectBardLoreEntries({ query: '앨리스', entries: restored, settings: createBardLoreSettings(), tokenCounts: Object.fromEntries(restored.map(item => [item.id, 100])) })
        expect(selection.selected.filter(item => item.entry.bard.kind === 'character').map(item => item.entry.comment)).toEqual(['Alice'])
        expect(selection.selected.some(item => item.entry.content === '#### Hogwarts')).toBe(true)
    })

    it('blocks stale previews and repeat splitting without overwriting edited children', () => {
        const entry = source(roster)
        const preview = previewBardLoreLocalSplit(entry)
        const changed = { ...entry, content: roster + 'Changed' }
        expect(applyBardLoreLocalSplit([changed], preview).conflicts).not.toHaveLength(0)
        const first = applyBardLoreLocalSplit([entry], preview)
        const secondPreview = previewBardLoreLocalSplit(first.entries[0], first.entries)
        expect(secondPreview.canApply).toBe(false)
        expect(applyBardLoreLocalSplit(first.entries, secondPreview).entries).toEqual(first.entries)
    })

    it('excludes an expensive table even when local splitting cannot safely parse it', () => {
        const table = source('| Name | Description |\n| --- | --- |\n' + Array.from({ length: 40 }, (_, i) => `| Item ${i} | A silver sword. |`).join('\n'), 'item list')
        expect(assessBardLoreBulkRisk(table, 60_000)).not.toBeNull()
        expect(previewBardLoreLocalSplit(table).canApply).toBe(false)
    })

    it('retains unknown attribute labels beneath explicit character anchors', () => {
        const preview = previewBardLoreLocalSplit(source('- Alice (Female):\n- Blood status: Pureblood\n- Wand: Oak\n- Bob (Male):\n- Blood status: Muggle-born\n- Wand: Ash'))
        expect(preview.atoms.map(atom => atom.name)).toEqual(['Alice', 'Bob'])
        expect(preview.atoms[0].content).toContain('Wand: Oak')
    })

    it('preserves distinguishing name qualifiers', () => {
        const preview = previewBardLoreLocalSplit(source('- Alice (Ghost): translucent\n- Alice (Living): solid'))
        expect(preview.atoms.map(atom => atom.name)).toEqual(['Alice (Ghost)', 'Alice (Living)'])
    })

    it('blocks ambiguous heading and bullet entity boundaries', () => {
        const preview = previewBardLoreLocalSplit(source('## NPC list\n### Alice\n- Fireball: attacks\n- Heal: repairs\n### Bob\n- Frost: freezes\n- Shield: protects'))
        expect(preview.canApply).toBe(false)
    })

    it('preserves scoped heading context as exact supporting source entries', () => {
        const entry = source('## NPC list\n### All members are hostile\n- Alice (Female): wizard\n- Bob (Male): wizard')
        const result = applyBardLoreLocalSplit([entry], previewBardLoreLocalSplit(entry))
        const alice = result.entries.find(item => item.comment === 'Alice')!
        const shared = result.entries.find(item => item.content === '### All members are hostile')!
        expect(shared).toBeDefined()
        expect(alice.bard.links).toContainEqual({ targetId: shared.id, relation: 'source-context', retrieval: 'supporting' })
    })
})
