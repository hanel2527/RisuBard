import { describe, expect, it } from 'vitest'
import { createRequiredWikiMessage, reserveRequiredWikiBudget } from './requiredWikiContext'

const sources = [{ id: 'narrative-memory:wiki:notes/plan.md', kind: 'memory' as const,
    role: 'system' as const, content: '## 흑막의 계획\n열 번째 턴에 정체를 밝힌다.', tokens: 300, priority: 200 }]

describe('required wiki context', () => {
    it('reserves mandatory tokens before optional retrieval and skips subminimum remainder', () => {
        const budget = { target: 2000, events: 2000, perSource: 2000, maximum: 6000 }
        expect(reserveRequiredWikiBudget(budget, sources)).toEqual({ ...budget, maximum: 5700 })
        expect(reserveRequiredWikiBudget({ ...budget, maximum: 555 }, sources)).toBeNull()
        expect(() => reserveRequiredWikiBudget({ ...budget, maximum: 256 }, sources)).toThrow()
    })
    it('creates a complete non-removable independent prompt with request provenance', () => {
        const message = createRequiredWikiMessage(sources, 'Respect the viewpoint knowledge boundary.')!
        expect(message.role).toBe('system')
        expect(message.removable).toBe(false)
        expect(message.content).toContain(sources[0].content)
        expect(message.content).toContain('Respect the viewpoint knowledge boundary.')
        expect(message.content).toContain(`[source ${JSON.stringify(sources[0].id)}]`)
        expect(message.requestStatusSources).toEqual([expect.objectContaining({ kind: 'wiki', content: sources[0].content })])
        expect(createRequiredWikiMessage([])).toBeNull()
    })
})
