import { describe, expect, test, vi } from 'vitest'
import {
    requestIsolatedMarkdownWikiBatchDrafts,
    requestMarkdownWikiDraft,
    saveCanonicalWikiDocument,
    type MarkdownWikiWriterModelCall,
} from './markdownWikiWriter'

const evidence = [{
    id: 'event.turn',
    type: 'event' as const,
    title: '소성당 전투',
    content: '# 소성당 전투\n\n라비안은 오른팔에 화상을 입었다.',
    sourceMessageIds: ['user-1', 'assistant-1'],
}]

describe('Markdown wiki writer', () => {
    test('repairs a truncated Markdown document and isolates general-chat extraction', async () => {
        const requestModel = vi.fn(async () => ({
            type: 'success', result: '## 라비안\n\n기록.',
            finishReason: requestModel.mock.calls.length === 1 ? 'max_tokens' : 'end_turn',
        }))
        await expect(requestMarkdownWikiDraft({ type: 'character', title: '라비안', instruction: '갱신해.', evidence, requestModel }))
            .resolves.toBe('## 라비안\n\n기록.')
        expect(requestModel).toHaveBeenCalledTimes(2)
        expect(requestModel).toHaveBeenLastCalledWith(expect.objectContaining({ extractJson: '' }), 'memory')
    })

    test('supports every canonical page type as an existing workbench target', async () => {
        await expect(requestMarkdownWikiDraft({
            type: 'faction',
            title: '은촛대 수도회',
            currentContent: '# 은촛대 수도회',
            instruction: '새 정보를 반영해.',
            evidence,
            requestModel: async () => ({
                type: 'success',
                result: '# 은촛대 수도회\n\n수도회 기록.',
            }),
        })).resolves.toContain('## 은촛대 수도회')
    })

    test('creates a bounded Markdown draft without storage or an operation schema', async () => {
        let submitted: MarkdownWikiWriterModelCall | undefined
        const requestModel = vi.fn(async (request: MarkdownWikiWriterModelCall) => {
            submitted = structuredClone(request)
            return {
                type: 'success',
                result: [
                    '---',
                    'model_owned: false',
                    '---',
                    '# 라비안',
                    '',
                    '## 현재 상태',
                    '',
                    '오른팔에 화상을 입었다.',
                ].join('\n'),
            }
        })

        await expect(requestMarkdownWikiDraft({
            type: 'character',
            title: '라비안',
            currentContent: '# 라비안\n\n건강하다.',
            instruction: '이번 전투 이후 상태를 갱신해.',
            evidence,
            requestModel,
        })).resolves.toBe([
            '## 라비안',
            '',
            '### 현재 상태',
            '',
            '오른팔에 화상을 입었다.',
        ].join('\n'))

        expect(submitted).toMatchObject({
            useStreaming: false,
            noMultiGen: true,
            tools: [],
            maxTokens: 4_096,
            logSource: 'memory',
            logPurpose: 'bardwiki-canonical-update',
        })
        expect(submitted).not.toHaveProperty('schema')
        expect(submitted?.formated[1].content).toContain('소성당 전투')
        expect(submitted?.formated[1].content).not.toContain('E:\\')
        expect(submitted?.formated[0].content).toContain('beginning with one ## title')
    })

    test.each([undefined, 'ko', 'en'] as const)('stores only after an explicit authenticated approval (language=%s)', async (writingLanguage) => {
        const fetchImpl = vi.fn(async (
            path: RequestInfo | URL,
            init?: RequestInit
        ) => {
            expect(String(path)).toBe(
                '/api/risubard/memory/wiki/document/save'
            )
            expect(init?.headers).toMatchObject({ 'risu-auth': 'jwt' })
            expect(JSON.parse(String(init?.body))).toMatchObject({
                type: 'character',
                title: '라비안',
                aliases: ['기사님'],
                sourceMessageIds: ['user-1', 'assistant-1'],
                reviewStatus: 'unreviewed',
                ...(writingLanguage ? { writingLanguage } : {}),
                retrievalMetadata: { keywords: ['기사', '화상'] },
            })
            return new Response(JSON.stringify({
                id: 'character.lavian',
                type: 'character',
                status: 'active',
                title: '라비안',
                aliases: ['기사님'],
                relativePath: 'characters/라비안.md',
                sourceMessageIds: ['user-1', 'assistant-1'],
                updated: '2026-08-08T00:00:00.000Z',
                content: '# 라비안\n\n현재 상태.',
                links: [],
                contextMode: 'auto',
                contentHash: 'hash-lavian',
                reviewStatus: 'unreviewed',
            }))
        })

        await expect(saveCanonicalWikiDocument({
            characterId: 'character',
            chatId: 'chat',
            type: 'character',
            title: '라비안',
            aliases: ['기사님'],
            sourceMessageIds: ['user-1', 'assistant-1'],
            markdown: '# 라비안\n\n현재 상태.',
            reviewStatus: 'unreviewed',
            writingLanguage,
            retrievalMetadata: { keywords: ['기사', '화상'] },
            fetchImpl,
            createAuth: async () => 'jwt',
        })).resolves.toMatchObject({
            id: 'character.lavian', aliases: ['기사님'],
            reviewStatus: 'unreviewed',
        })
        expect(fetchImpl).toHaveBeenCalledOnce()
    })

    test('creates isolated batch drafts sequentially with one target per request', async () => {
        let active = 0
        let maximumActive = 0
        const seenTargets: string[] = []
        const requestModel = vi.fn(async (request: MarkdownWikiWriterModelCall) => {
            active += 1
            maximumActive = Math.max(maximumActive, active)
            const payload = JSON.parse(request.formated[1].content)
            seenTargets.push(payload.target.title)
            await Promise.resolve()
            active -= 1
            return {
                type: 'success',
                result: `# ${payload.target.title}\n\n격리된 초안.`,
            }
        })

        const drafts = await requestIsolatedMarkdownWikiBatchDrafts({
            targets: [{
                id: 'character.lavian', type: 'character', title: '라비안',
                content: '# 라비안\n\n기존.', contentHash: 'hash-a',
            }, {
                id: 'location.tower', type: 'location', title: '고립된 탑',
                content: '# 고립된 탑\n\n기존.', contentHash: 'hash-b',
            }],
            instruction: '현재 근거를 반영해.',
            evidence,
            requestModel,
        })

        expect(maximumActive).toBe(1)
        expect(seenTargets).toEqual(['라비안', '고립된 탑'])
        expect(drafts).toEqual([
            expect.objectContaining({ documentId: 'character.lavian', contentHash: 'hash-a' }),
            expect.objectContaining({ documentId: 'location.tower', contentHash: 'hash-b' }),
        ])
    })
})
