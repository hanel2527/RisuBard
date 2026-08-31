// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { createBardLoreSettings, fingerprintBardLoreEntry, type BardLoreEntry } from 'src/ts/lorebook/bardLore'
import BardLoreAnalysisPanel from './BardLoreAnalysisPanel.svelte'

const requestChatData = vi.hoisted(() => vi.fn())
const tokenizerMock = vi.hoisted(() => vi.fn(async () => 20))
vi.mock('src/ts/process/request/request', () => ({ requestChatData }))
vi.mock('src/ts/tokenizer', () => ({ tokenize: tokenizerMock }))

const source: BardLoreEntry = {
    id: 'source',
    key: '탑',
    secondkey: '',
    insertorder: 10,
    comment: '탑',
    content: '도시의 탑',
    mode: 'normal',
    alwaysActive: false,
    selective: false,
    bard: {
        sourceLegacyId: 'source',
        sourceHash: 'legacy',
        kind: 'other',
        activation: 'retrieve',
        aliases: [],
        tags: [],
        summary: '',
        facets: [],
        injection: 'full',
        links: [],
    },
}

let mounted: ReturnType<typeof mount> | undefined
afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
    requestChatData.mockReset()
    tokenizerMock.mockClear()
})

describe('BardLoreAnalysisPanel', () => {
    it('shows the exact deterministic quality gaps before the user trusts the Grimoire', async () => {
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source],
                settings: createBardLoreSettings(),
                onChange: vi.fn(),
            },
        })

        await tick()
        const status = document.body.querySelector('[data-bard-lore-quality-status="fail"]')!
        expect(status).not.toBeNull()
        expect(status.textContent).toContain('탑')
        expect(status.querySelector('[data-bard-lore-quality-issue="missing-summary"]')).not.toBeNull()
        expect(status.querySelector('[data-bard-lore-quality-issue="missing-tags"]')).not.toBeNull()
    })
    it('automatically repairs a schema-valid draft that fails the local quality gate', async () => {
        requestChatData
            .mockResolvedValueOnce({
                type: 'success',
                result: JSON.stringify({
                    entries: [{
                        ref: 0,
                        kind: 'character',
                        aliases: ['탑지기'],
                        tags: [],
                        summary: '도시의 탑을 지키는 인물.',
                        facets: [],
                        injection: 'full',
                        atoms: [],
                        links: [],
                    }],
                }),
            })
            .mockResolvedValueOnce({
                type: 'success',
                result: JSON.stringify({
                    entries: [{
                        ref: 0,
                        kind: 'character',
                        aliases: ['탑지기'],
                        tags: ['인물'],
                        summary: '도시의 탑을 지키는 인물.',
                        facets: [],
                        injection: 'full',
                        atoms: [],
                        links: [],
                    }],
                }),
            })
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source],
                settings: createBardLoreSettings(),
                onChange: vi.fn(),
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-plan]')).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analyze]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-draft="source"]')).not.toBeNull())

        expect(requestChatData).toHaveBeenCalledTimes(2)
        expect(requestChatData.mock.calls[1][0].formated[0].content).toContain('missing-tags')
    })

    it('prepares an AI repair run for only the entries that fail deterministic quality checks', async () => {
        const healthy = structuredClone(source)
        healthy.id = 'healthy'
        healthy.comment = '완료 항목'
        healthy.bard.tags = ['장소']
        healthy.bard.summary = '이미 검색 가능한 항목.'
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source, healthy],
                settings: createBardLoreSettings(),
                onChange: vi.fn(),
                onAnalysisRunChange: vi.fn(),
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-quality-repair]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-plan]')).not.toBeNull())

        expect(document.body.querySelector('[data-bard-lore-analysis-target="source"]')).not.toBeNull()
        expect(document.body.querySelector('[data-bard-lore-analysis-target="healthy"]')).toBeNull()
    })
    it('edits analysis limits in the dialog and replans before starting', async () => {
        requestChatData.mockResolvedValue({
            type: 'success',
            result: JSON.stringify({
                entries: [{ ref: 0, kind: 'location', aliases: [], tags: ['장소'], summary: '도시의 탑.', links: [] }],
            }),
        })
        const onSettingsChange = vi.fn()
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source],
                settings: createBardLoreSettings({ analysisOutputTokens: 200 }),
                onChange: vi.fn(),
                onSettingsChange,
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-plan]')).not.toBeNull())
        const output = document.body.querySelector<HTMLInputElement>('[data-bard-lore-analysis-setting="analysisOutputTokens"]')!
        expect(output).not.toBeNull()
        output.value = '6400'
        output.dispatchEvent(new Event('change', { bubbles: true }))
        await vi.waitFor(() => expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ analysisOutputTokens: 6400 })))
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-plan]')).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analyze]')!.click()
        await vi.waitFor(() => expect(requestChatData).toHaveBeenCalled())

        expect(requestChatData.mock.calls[0][0].maxTokens).toBe(6400)
    })

    it('previews every selected lore entry and its original content before charging tokens', async () => {
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source],
                settings: createBardLoreSettings(),
                onChange: vi.fn(),
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-target="source"]')).not.toBeNull())

        const preview = document.body.querySelector('[data-bard-lore-analysis-target="source"]')!
        expect(preview.textContent).toContain('탑')
        expect(preview.textContent).toContain('도시의 탑')
        expect(requestChatData).not.toHaveBeenCalled()
    })

    it('stops and persists a paused run when the dialog closes', async () => {
        requestChatData.mockImplementation((_arg, _mode, signal: AbortSignal) => new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ type: 'fail', result: 'aborted' }), { once: true })
        }))
        const onAnalysisRunChange = vi.fn()
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source],
                settings: createBardLoreSettings(),
                onChange: vi.fn(),
                onAnalysisRunChange,
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-plan]')).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analyze]')!.click()
        await vi.waitFor(() => expect(requestChatData).toHaveBeenCalled())
        document.body.querySelector<HTMLButtonElement>('.risu-modal-close')!.click()
        await vi.waitFor(() => expect(onAnalysisRunChange.mock.calls.at(-1)?.[0]?.status).toBe('paused'))
        expect(requestChatData.mock.calls[0][2].aborted).toBe(true)
    })

    it('shows persisted drafts and failed-batch reasons after reopening', async () => {
        requestChatData.mockResolvedValue({ type: 'success', result: '{invalid' })
        const onAnalysisRunChange = vi.fn()
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source],
                settings: createBardLoreSettings(),
                onChange: vi.fn(),
                onAnalysisRunChange,
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-plan]')).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analyze]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-failure]')).not.toBeNull())

        const failure = document.body.querySelector('[data-bard-lore-analysis-failure]')!
        expect(failure.textContent).toContain('JSON')
        document.body.querySelector<HTMLButtonElement>('.risu-modal-close')!.click()
        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-failure]')).not.toBeNull())
        expect(document.body.querySelector('[data-bard-lore-analysis-target="source"]')).not.toBeNull()
    })

    it('automatically splits an invalid multi-entry JSON batch and completes the smaller batches', async () => {
        const second = structuredClone(source)
        second.id = 'second'
        second.key = '항구'
        second.comment = '항구'
        second.content = '도시의 항구'
        second.bard.sourceLegacyId = 'second'
        requestChatData
            .mockResolvedValueOnce({
                type: 'fail',
                result: '[PageFold] Structured output validation failed: Structured output is not valid JSON. (finish reason: MAX_TOKENS)',
            })
            .mockResolvedValueOnce({
                type: 'success',
                result: JSON.stringify({
                    entries: [{ ref: 0, kind: 'location', aliases: [], tags: ['장소'], summary: '도시의 탑.', links: [] }],
                }),
            })
            .mockResolvedValueOnce({
                type: 'success',
                result: JSON.stringify({
                    entries: [{ ref: 1, kind: 'location', aliases: [], tags: ['장소'], summary: '도시의 항구.', links: [] }],
                }),
            })
        const onAnalysisRunChange = vi.fn()
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source, second],
                settings: createBardLoreSettings({ analysisBatchEntries: 2 }),
                onChange: vi.fn(),
                onAnalysisRunChange,
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-plan]')).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analyze]')!.click()
        await vi.waitFor(() => expect(requestChatData).toHaveBeenCalledTimes(3))
        await vi.waitFor(() => expect(onAnalysisRunChange.mock.calls.at(-1)?.[0]).toMatchObject({
            status: 'review',
            batches: [{ status: 'complete' }, { status: 'complete' }],
        }))

        expect(document.body.querySelector('[data-bard-lore-analysis-failure]')).toBeNull()
        expect(document.body.querySelector('[data-bard-lore-analysis-draft="source"]')).not.toBeNull()
        expect(document.body.querySelector('[data-bard-lore-analysis-draft="second"]')).not.toBeNull()
    })

    it('regenerates one invalid atomic singleton with a smaller response contract', async () => {
        requestChatData
            .mockResolvedValueOnce({ type: 'success', result: '{invalid' })
            .mockResolvedValueOnce({
                type: 'success',
                result: JSON.stringify({
                    entries: [{ ref: 0, kind: 'location', aliases: [], tags: ['장소'], summary: '도시의 탑.', links: [] }],
                }),
            })
        const onAnalysisRunChange = vi.fn()
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source],
                settings: createBardLoreSettings(),
                onChange: vi.fn(),
                onAnalysisRunChange,
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-plan]')).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analyze]')!.click()
        await vi.waitFor(() => expect(requestChatData).toHaveBeenCalledTimes(2))
        await vi.waitFor(() => expect(onAnalysisRunChange.mock.calls.at(-1)?.[0]?.status).toBe('review'))

        expect(requestChatData.mock.calls[1][0].formated[0].content).toContain('ordinary atomic entry')
        expect(requestChatData.mock.calls[1][0].schema).not.toContain('"atoms"')
        expect(requestChatData.mock.calls[1][0].schema.length).toBeLessThan(requestChatData.mock.calls[0][0].schema.length)
        expect(document.body.querySelector('[data-bard-lore-analysis-draft="source"]')).not.toBeNull()
    })

    it('replans failed work with changed limits and uses them on retry', async () => {
        requestChatData
            .mockResolvedValueOnce({ type: 'success', result: '{"entries":[]}' })
            .mockResolvedValueOnce({
                type: 'success',
                result: JSON.stringify({
                    entries: [{ ref: 0, kind: 'location', aliases: [], tags: ['장소'], summary: '도시의 탑.', links: [] }],
                }),
            })
        const onAnalysisRunChange = vi.fn()
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source],
                settings: createBardLoreSettings({ analysisOutputTokens: 200 }),
                onChange: vi.fn(),
                onSettingsChange: vi.fn(),
                onAnalysisRunChange,
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-plan]')).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analyze]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-failure]')).not.toBeNull())
        const output = document.body.querySelector<HTMLInputElement>('[data-bard-lore-analysis-setting="analysisOutputTokens"]')!
        output.value = '6400'
        output.dispatchEvent(new Event('change', { bubbles: true }))
        await vi.waitFor(() => expect(onAnalysisRunChange.mock.calls.at(-1)?.[0]).toMatchObject({
            status: 'paused',
            settingsSnapshot: { analysisOutputTokens: 6400 },
            batches: [{ status: 'pending' }],
        }))
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-resume]')!.click()
        await vi.waitFor(() => expect(requestChatData).toHaveBeenCalledTimes(2))

        expect(requestChatData.mock.calls[1][0].maxTokens).toBe(6400)
    })

    it('explains legacy generic validation failures instead of exposing an internal code', async () => {
        const settings = createBardLoreSettings()
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source],
                settings,
                analysisRun: {
                    schemaVersion: 1,
                    id: 'legacy-run',
                    scope: 'all',
                    targetIds: ['source'],
                    createdAt: '2026-08-31T00:00:00.000Z',
                    updatedAt: '2026-08-31T00:00:00.000Z',
                    status: 'failed',
                    settingsSnapshot: settings,
                    overwriteExisting: false,
                    batches: [{
                        id: 'legacy-batch',
                        index: 0,
                        targetIds: ['source'],
                        estimatedInputTokens: 20,
                        status: 'failed',
                        error: 'bard-lore-analysis-invalid',
                    }],
                },
                onChange: vi.fn(),
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-failure]')).not.toBeNull())
        const text = document.body.querySelector('[data-bard-lore-analysis-failure]')!.textContent ?? ''
        expect(text).toContain('schema')
        expect(text).not.toContain('bard-lore-analysis-invalid')
    })

    it('keeps AI metadata as a preview until explicit approval', async () => {
        requestChatData.mockResolvedValue({
            type: 'success',
            result: JSON.stringify({
                entries: [{
                    ref: 0,
                    kind: 'location',
                    aliases: ['타워'],
                    tags: ['도시'],
                    summary: '도시의 탑',
                    links: [],
                }],
            }),
        })
        const onChange = vi.fn()
        const onAnalysisRunChange = vi.fn()
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(BardLoreAnalysisPanel, {
            target,
            props: {
                entries: [source],
                settings: createBardLoreSettings({
                    analysisBatchEntries: 1,
                    analysisInputTokens: 100,
                    analysisOutputTokens: 200,
                    analysisTemperature: 0.25,
                }),
                activeEntryId: 'source',
                onChange,
                onAnalysisRunChange,
            },
        })
        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-plan]')).not.toBeNull())
        expect(requestChatData).not.toHaveBeenCalled()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analyze]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-draft="source"]')).not.toBeNull())

        expect(onChange).not.toHaveBeenCalled()
        expect(onAnalysisRunChange).toHaveBeenCalled()
        expect(requestChatData.mock.calls[0][0]).toMatchObject({
            maxTokens: 200,
            temperature: 0.25,
            logPurpose: 'bard-lore-analysis',
            disablePromptCache: false,
        })
        expect(tokenizerMock).toHaveBeenCalledWith(expect.stringContaining('"required":["entries"]'))

        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-apply]')!.click()
        await tick()

        expect(onChange).toHaveBeenCalledOnce()
        expect((onChange.mock.calls[0][0] as BardLoreEntry[])[0].bard).toMatchObject({
            kind: 'location',
            aliases: ['타워'],
            tags: ['도시'],
        })
    })

    it('keeps the first completed batch when a later response is invalid', async () => {
        const second = structuredClone(source)
        second.id = 'second'
        second.comment = 'second'
        second.key = 'second'
        second.bard.sourceLegacyId = 'second'
        requestChatData
            .mockResolvedValueOnce({
                type: 'success',
                result: JSON.stringify({
                    entries: [{
                        ref: 0,
                        kind: 'location',
                        aliases: [],
                        tags: ['도시'],
                        summary: '보존될 초안',
                        links: [],
                    }],
                }),
            })
            .mockResolvedValueOnce({ type: 'success', result: '{invalid' })
        const onAnalysisRunChange = vi.fn()
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source, second],
                settings: createBardLoreSettings({
                    analysisBatchEntries: 1,
                    analysisInputTokens: 100,
                    analysisOutputTokens: 100,
                }),
                onChange: vi.fn(),
                onAnalysisRunChange,
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-plan]')).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analyze]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-retry]')).not.toBeNull())

        expect(document.body.querySelector('[data-bard-lore-analysis-draft="source"]')).not.toBeNull()
        const saved = onAnalysisRunChange.mock.calls.at(-1)?.[0]
        expect(saved.batches.map((batch: { status: string }) => batch.status)).toEqual(['complete', 'failed'])
        expect(saved.batches[0].candidates[0].summary).toBe('보존될 초안')
    })

    it('keeps pending batches resumable after approving completed drafts', async () => {
        const second = structuredClone(source)
        second.id = 'second'
        second.comment = '남은 항목'
        second.key = '남은 항목'
        second.bard.sourceLegacyId = 'second'
        const settings = createBardLoreSettings({ analysisBatchEntries: 1 })
        const onAnalysisRunChange = vi.fn()
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source, second],
                settings,
                analysisRun: {
                    schemaVersion: 1,
                    id: 'partially-complete-run',
                    scope: 'all',
                    targetIds: ['source', 'second'],
                    createdAt: '2026-08-31T00:00:00.000Z',
                    updatedAt: '2026-08-31T00:00:00.000Z',
                    status: 'paused',
                    settingsSnapshot: settings,
                    overwriteExisting: false,
                    batches: [
                        {
                            id: 'complete-batch',
                            index: 0,
                            targetIds: ['source'],
                            estimatedInputTokens: 20,
                            status: 'complete',
                            candidates: [{
                                id: 'source',
                                sourceHash: fingerprintBardLoreEntry(source),
                                kind: 'location',
                                aliases: [],
                                tags: ['도시'],
                                summary: '승인할 초안',
                                links: [],
                            }],
                        },
                        {
                            id: 'pending-batch',
                            index: 1,
                            targetIds: ['second'],
                            estimatedInputTokens: 20,
                            status: 'pending',
                        },
                    ],
                },
                onChange: vi.fn(),
                onAnalysisRunChange,
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-analysis-apply]')).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-apply]')!.click()
        await tick()

        expect(onAnalysisRunChange.mock.calls.at(-1)?.[0]).toMatchObject({
            status: 'paused',
            targetIds: ['second'],
            batches: [{ id: 'pending-batch', status: 'pending' }],
        })
        expect(document.body.querySelector('[data-bard-lore-analysis-resume]')).not.toBeNull()
    })

    it('offers resume for a persisted failed run that still has pending batches', async () => {
        const settings = createBardLoreSettings()
        requestChatData.mockResolvedValue({
            type: 'success',
            result: JSON.stringify({
                entries: [{ ref: 0, kind: 'location', aliases: [], tags: ['장소'], summary: '도시의 탑.', links: [] }],
            }),
        })
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source],
                settings,
                analysisRun: {
                    schemaVersion: 1,
                    id: 'legacy-failed-pending-run',
                    scope: 'all',
                    targetIds: ['source'],
                    createdAt: '2026-08-31T00:00:00.000Z',
                    updatedAt: '2026-08-31T00:00:00.000Z',
                    status: 'failed',
                    settingsSnapshot: settings,
                    overwriteExisting: false,
                    batches: [{
                        id: 'pending-batch',
                        index: 0,
                        targetIds: ['source'],
                        estimatedInputTokens: 20,
                        status: 'pending',
                    }],
                },
                onChange: vi.fn(),
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await tick()

        expect(document.body.querySelector('[data-bard-lore-analysis-resume]')).not.toBeNull()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-resume]')!.click()
        await vi.waitFor(() => expect(requestChatData).toHaveBeenCalledOnce())
    })

    it('does not offer resume for an externally running batch', async () => {
        const settings = createBardLoreSettings()
        mounted = mount(BardLoreAnalysisPanel, {
            target: document.body.appendChild(document.createElement('div')),
            props: {
                entries: [source],
                settings,
                analysisRun: {
                    schemaVersion: 1,
                    id: 'externally-running-run',
                    scope: 'all',
                    targetIds: ['source'],
                    createdAt: '2026-08-31T00:00:00.000Z',
                    updatedAt: '2026-08-31T00:00:00.000Z',
                    status: 'running',
                    settingsSnapshot: settings,
                    overwriteExisting: false,
                    batches: [{
                        id: 'running-batch',
                        index: 0,
                        targetIds: ['source'],
                        estimatedInputTokens: 20,
                        status: 'running',
                    }],
                },
                onChange: vi.fn(),
            },
        })

        await tick()
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-analysis-open]')!.click()
        await tick()

        expect(document.body.querySelector('[data-bard-lore-analysis-resume]')).toBeNull()
    })
})
