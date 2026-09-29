// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import RisuBardCharacterChronicle from './RisuBardCharacterChronicle.svelte'
import type { WikiDocument } from 'src/ts/risubard/wikiLink'

let mounted: ReturnType<typeof mount> | undefined
afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})
const character: WikiDocument = {
    id: 'alice', type: 'character', title: '아주 긴 한국어 이름의 앨리스', aliases: ['여왕'], status: 'active',
    relativePath: 'characters/alice.md', sourceMessageIds: [], updated: '2026-09-29',
    content: '', links: [], contextMode: 'auto', contentHash: 'hash',
}
const events = Array.from({ length: 21 }, (_, i): WikiDocument => ({
    ...character, id: `event-${String(i).padStart(2, '0')}`, type: 'event', title: `사건 ${i + 1}`,
    sourceMessageIds: i === 20 ? [] : ['message-1'], links: ['alice'], content: '한국어 기록 '.repeat(100),
}))

describe('character chronicle view', () => {
    it('paginates related events and separates original-message and event-editor navigation', async () => {
        const onNavigate = vi.fn(), onEdit = vi.fn()
        mounted = mount(RisuBardCharacterChronicle, { target: document.body, props: {
            documents: [character, ...events], onNavigate, onEdit,
        } })
        await tick()
        expect(document.querySelectorAll('[data-chronicle-entry]')).toHaveLength(20)
        document.querySelector<HTMLButtonElement>('[data-chronicle-source]')!.click()
        expect(onNavigate).toHaveBeenCalledWith({ kind: 'chat', messageIds: ['message-1'] })
        document.querySelector<HTMLButtonElement>('[data-chronicle-edit]')!.click()
        expect(onEdit).toHaveBeenCalledWith('event-00')
        document.querySelector<HTMLButtonElement>('[aria-label="다음 연대기 페이지"]')!.click()
        await tick()
        expect(document.querySelectorAll('[data-chronicle-entry]')).toHaveLength(1)
        expect(document.querySelector<HTMLButtonElement>('[data-chronicle-source]')!.disabled).toBe(true)
        expect(document.body.textContent).toContain('원문 출처 없음')
        expect(document.body.textContent).toContain('2 / 2')
    })
    it('searches character aliases and presents a useful empty state', async () => {
        mounted = mount(RisuBardCharacterChronicle, { target: document.body, props: { documents: [character] } })
        await tick()
        expect(document.body.textContent).toContain('연결된 사건이 없습니다')
        const search = document.querySelector<HTMLInputElement>('[aria-label="인물 이름 또는 별칭 검색"]')!
        search.value = '여왕'
        search.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(document.querySelectorAll('option')).toHaveLength(1)
        search.value = '없는 인물'
        search.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(document.body.textContent).toContain('검색에 맞는 인물이 없습니다')
        expect(document.querySelectorAll('[data-chronicle-entry]')).toHaveLength(0)
    })
})
