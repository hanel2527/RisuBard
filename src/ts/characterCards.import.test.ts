import { beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
    events: [] as string[],
    doneCalls: 0,
    completion: Promise.resolve(),
    db: {
        statics: { imports: 0 },
        characters: [],
    },
}))

vi.mock('./alert', () => ({
    alertCardExport: vi.fn(),
    alertConfirm: vi.fn(),
    alertError: vi.fn(() => state.events.push('error')),
    alertInput: vi.fn(),
    alertStore: { set: vi.fn() },
    alertTOS: vi.fn(),
    alertWait: vi.fn(),
    notifyError: vi.fn(),
    notifySuccess: vi.fn(),
}))

vi.mock('./storage/database.svelte', () => ({
    appVer: 'test',
    defaultSdDataFunc: () => ({}),
    getDatabase: () => state.db,
    importPreset: vi.fn(),
    newChatModelDefaults: () => ({}),
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
}))

vi.mock('./process/processzip', () => ({
    CharXImporter: class {
        alertInfo = false
        assets = {}
        cardData: string | undefined
        moduleData: Uint8Array | undefined

        async parse() {
            state.completion = new Promise<void>((resolve) => {
                setTimeout(() => {
                    this.cardData = JSON.stringify({ spec: 'not-v3', data: {} })
                    state.events.push('assets-5/5')
                    resolve()
                }, 0)
            })
        }

        async done() {
            state.doneCalls += 1
            await state.completion
        }
    },
    CharXSkippableChecker: vi.fn(),
    CharXWriter: class {},
}))

vi.mock('./globalApi.svelte', () => ({
    AppendableBuffer: class {},
    BlankWriter: class {},
    LocalWriter: class {},
    VirtualWriter: class {},
    checkCharOrder: vi.fn(),
    downloadFile: vi.fn(),
    forageStorage: {},
    loadAsset: vi.fn(),
    readImage: vi.fn(),
    saveAsset: vi.fn(),
}))

vi.mock('./process/modules', () => ({
    exportModuleLegacy: vi.fn(),
    readModule: vi.fn(),
}))

vi.mock('./stores.svelte', () => ({ selectedCharID: { set: vi.fn() } }))
vi.mock('./routing', () => ({ openSettings: vi.fn(), SettingsRoute: {} }))
vi.mock('./media', () => ({ compressImage: vi.fn(), getImageType: vi.fn() }))
vi.mock('./parser/parser.svelte', () => ({ hasher: vi.fn(), risuChatParser: vi.fn() }))
vi.mock('./process/files/inlays', () => ({ reencodeImage: vi.fn() }))
vi.mock('./characterVault', () => ({ pinCharacterVaultQuickAccess: vi.fn() }))
vi.mock('src/lang', () => ({
    language: {
        errors: { noData: 'invalid-data' },
        importedCharacter: 'imported',
    },
}))

import { createBaseV2, createBaseV3, importCharacterProcess } from './characterCards'
import { createBardLoreSettings } from './lorebook/bardLore'

function cardFixture(spec: 'chara_card_v2'|'chara_card_v3', risuai: Record<string, unknown>|undefined, postHistory = 'legacy card global note') {
    return {
        spec,
        spec_version: spec === 'chara_card_v2' ? '2.0' : '3.0',
        data: {
            name: 'Legacy card', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: postHistory,
            alternate_greetings: [], tags: [], creator: '', character_version: '',
            extensions: risuai === undefined ? {} : { risuai },
        },
    }
}

async function importFixture(card: ReturnType<typeof cardFixture>) {
    state.db.characters = []
    await importCharacterProcess({
        name: 'fixture.json',
        data: Buffer.from(JSON.stringify(card)),
    })
    return state.db.characters[0]
}

describe('CharX import completion', () => {
    beforeEach(() => {
        state.events = []
        state.doneCalls = 0
        state.completion = Promise.resolve()
        state.db.statics.imports = 0
    })

    test('waits for delayed archive completion before validating card metadata', async () => {
        await importCharacterProcess({
            name: 'realm.charx',
            data: new Uint8Array(),
        })
        await state.completion

        expect(state.doneCalls).toBe(1)
        expect(state.events).toEqual(['assets-5/5', 'error'])
    })
})

describe('legacy character-card replace-global-note compatibility', () => {
    test.each(['chara_card_v2', 'chara_card_v3'] as const)('restores legacy replaceGlobalNote from %s cards with a Risu extension that does not own it', async (spec) => {
        const imported = await importFixture(cardFixture(spec, {}))

        expect(imported).toMatchObject({
            postHistoryInstructions: 'legacy card global note',
            replaceGlobalNote: 'legacy card global note',
        })
    })

    test('does not fall back when a new card explicitly owns an empty replaceGlobalNote', async () => {
        const imported = await importFixture(cardFixture('chara_card_v3', { replaceGlobalNote: '' }, 'standard post history'))

        expect(imported).toMatchObject({
            postHistoryInstructions: 'standard post history',
            replaceGlobalNote: '',
        })
    })

    test.each(['chara_card_v2', 'chara_card_v3'] as const)('does not create a Risu replaceGlobalNote for ordinary %s cards', async (spec) => {
        const imported = await importFixture(cardFixture(spec, undefined, 'standard post history'))

        expect(imported).toMatchObject({
            postHistoryInstructions: 'standard post history',
            replaceGlobalNote: '',
        })
    })

    test('imports Risu module extension fields through the public card lifecycle', async () => {
        const imported = await importFixture(cardFixture('chara_card_v3', {
            moduleNamespace: 'fixture-namespace', hideChatIcon: true,
        }, ''))

        expect(imported).toMatchObject({ moduleNamespace: 'fixture-namespace', hideChatIcon: true })
    })
})

describe('public character-card lifecycle round-trips', () => {
    test.each([
        ['v2', createBaseV2],
        ['v3', createBaseV3],
    ] as const)('preserves namespaced Bard Lore without changing the standard lorebook through %s', async (_spec, createCard) => {
        const legacyLore = [{
            id: 'legacy',
            key: 'legacy',
            secondkey: '',
            insertorder: 10,
            comment: 'Legacy',
            content: 'Legacy content',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
        }]
        const bardEntry = {
            ...legacyLore[0],
            id: 'bard',
            comment: 'Bard',
            content: 'Bard content',
            bard: {
                sourceLegacyId: 'legacy',
                sourceHash: 'hash',
                kind: 'location',
                activation: 'retrieve',
                aliases: ['장소'],
                tags: ['데이트'],
                summary: '장소 요약',
                facets: [],
                injection: 'full',
                links: [],
            },
        }
        const source = {
            name: 'Bard Lore lifecycle',
            globalLore: legacyLore,
            loreExt: {},
            bardLore: {
                schemaVersion: 1,
                mode: 'bard',
                entries: [bardEntry],
                settings: createBardLoreSettings({ maximumTokens: 777, maxEntries: 3 }),
                analysisRun: {
                    schemaVersion: 1,
                    id: 'run',
                    scope: 'all',
                    targetIds: ['bard'],
                    createdAt: '2026-08-31T00:00:00.000Z',
                    updatedAt: '2026-08-31T00:00:00.000Z',
                    status: 'review',
                    settingsSnapshot: createBardLoreSettings({ maximumTokens: 777, maxEntries: 3 }),
                    overwriteExisting: false,
                    batches: [{
                        id: 'batch',
                        index: 0,
                        targetIds: ['bard'],
                        estimatedInputTokens: 120,
                        status: 'complete',
                        candidates: [{
                            id: 'bard',
                            sourceHash: 'draft-hash',
                            kind: 'location',
                            aliases: ['장소'],
                            tags: ['데이트'],
                            summary: '검토 대기',
                            facets: [],
                            injection: 'full',
                            atoms: [],
                            links: [],
                        }],
                    }],
                },
            },
        } as any

        const exported = createCard(source)
        expect(exported.data.character_book?.entries).toHaveLength(1)
        expect(exported.data.character_book?.entries[0]).toMatchObject({
            name: 'Legacy',
            content: 'Legacy content',
        })
        expect((exported.data.extensions as any).risubard.bardLore.settings.maximumTokens).toBe(777)

        const imported = await importFixture(exported as any)
        const reexported = createCard(imported)

        expect(imported.globalLore).toHaveLength(1)
        expect(imported.bardLore).toEqual(source.bardLore)
        expect((reexported.data.extensions as any).risubard.bardLore).toEqual(source.bardLore)
    })

    test.each([
        ['v2', createBaseV2],
        ['v3', createBaseV3],
    ] as const)('ignores malformed Bard Lore metadata without breaking the standard lorebook through %s', async (_spec, createCard) => {
        const exported = createCard({
            name: 'Standard compatibility',
            globalLore: [{
                id: 'legacy',
                key: 'legacy',
                secondkey: '',
                insertorder: 10,
                comment: 'Legacy',
                content: 'Legacy content',
                mode: 'normal',
                alwaysActive: false,
                selective: false,
            }],
            loreExt: {},
        } as any)
        ;(exported.data.extensions as any).risubard = {
            bardLore: { schemaVersion: 999, entries: 'invalid' },
        }

        const imported = await importFixture(exported as any)

        expect(imported.globalLore).toHaveLength(1)
        expect(imported.globalLore[0]).toMatchObject({
            comment: 'Legacy',
            content: 'Legacy content',
        })
        expect(imported.bardLore).toBeUndefined()
    })

    test.each([
        ['v2', createBaseV2],
        ['v3', createBaseV3],
    ] as const)('preserves Risu extensions and post-history instructions through %s export, import, and re-export', async (_spec, createCard) => {
        const source = {
            name: 'Lifecycle fixture', globalLore: [], loreExt: {},
            postHistoryInstructions: 'standard post-history instructions',
            replaceGlobalNote: 'explicit Risu global-note replacement',
            moduleNamespace: 'lifecycle-namespace',
            hideChatIcon: true,
        } as any

        const imported = await importFixture(createCard(source) as any)
        const reexported = createCard(imported)

        expect(imported).toMatchObject({
            postHistoryInstructions: source.postHistoryInstructions,
            replaceGlobalNote: source.replaceGlobalNote,
            moduleNamespace: source.moduleNamespace,
            hideChatIcon: source.hideChatIcon,
        })
        expect(reexported.data.post_history_instructions).toBe(source.postHistoryInstructions)
        expect(reexported.data.extensions.risuai).toMatchObject({
            replaceGlobalNote: source.replaceGlobalNote,
            moduleNamespace: source.moduleNamespace,
            hideChatIcon: source.hideChatIcon,
        })
    })
})
