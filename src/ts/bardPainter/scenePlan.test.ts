import { describe, expect, it } from 'vitest'
import { buildPainterImageRequest, parsePainterDraft } from './prompt'
import { PAINTER_STYLES } from './styles'
import { createPainterSettings } from './types'

const subject = (name: string) => ({
    id: '', name, aliases: [], kind: 'character', appearance: 'brown hair', clothing: 'blue coat, black boots', state: '', negative: '',
    pose: { tags: 'standing', placement: '', posture: '', action: '', expression: '', gaze: '' },
})
const plan = () => ({
    version: 2, rendering: '', negative: '',
    scene: { tags: '1girl, 1boy', location: 'A quiet station platform at dusk.', framing: 'Both figures shown from the waist up.', camera: 'Eye-level view from across the tracks.' },
    subjects: [subject('Aria'), subject('Leon')],
    interactions: [{ source: 1, target: 0, description: 'The man on the right passes a cup to the woman on the left.', sourceAction: 'Extends a cup toward the woman on the left.', targetAction: 'Receives the cup from the man on the right.' }],
})

describe('BardPainter scene-plan compilation', () => {
    it('routes relations to their participants and compiles composition and natural language into editable blocks', () => {
        const input = plan()
        input.subjects[0].pose = { tags: 'standing', placement: 'On the left.', posture: 'Leaning forward slightly.', action: '', expression: 'A slight smile.', gaze: 'Looking at the cup.' }
        const draft = parsePainterDraft(JSON.stringify(input))
        expect(draft.scene).toBe('1girl, 1boy\nA quiet station platform at dusk.\nBoth figures shown from the waist up.\nEye-level view from across the tracks.\nThe man on the right passes a cup to the woman on the left.')
        expect(draft.subjects[0].pose).toBe('standing\nOn the left.\nLeaning forward slightly.\nReceives the cup from the man on the right.\nA slight smile.\nLooking at the cup.')
        expect(draft.subjects[1].pose).toBe('standing\nExtends a cup toward the woman on the left.')
        expect(draft.subjects[0].clothing).toBe('blue coat, black boots')
        expect(draft).not.toHaveProperty('interactions')
        const request = buildPainterImageRequest(draft, PAINTER_STYLES[0], createPainterSettings(), 1)
        expect(request.parameters.v4_prompt.caption.base_caption).toBe(draft.scene)
        expect(request.parameters.characterPrompts[0].prompt).toContain('Receives the cup')
        expect(request.parameters.characterPrompts[0].prompt).not.toContain('Extends a cup')
        expect(request.parameters.characterPrompts[1].prompt).toContain('Extends a cup')
        expect(request.input).not.toContain('blue coat')
    })

    it('keeps subsequent manual edits authoritative and round-trips the compiled legacy draft', () => {
        const draft = parsePainterDraft(JSON.stringify(plan()))
        draft.scene = '  my own scene  '
        draft.subjects[0].prompt = '  custom appearance\n\ncustom outfit\n\ncustom pose  '
        expect(parsePainterDraft(JSON.stringify(draft)).subjects[0].prompt).toBe(draft.subjects[0].prompt)
        const request = buildPainterImageRequest(draft, PAINTER_STYLES[0], createPainterSettings(), 1)
        expect(request.input).toBe('my own scene')
        expect(request.parameters.characterPrompts[0].prompt).toBe(draft.subjects[0].prompt)
    })

    it('accepts scenery without actors and does not require artificial actions or interactions', () => {
        const input = { ...plan(), subjects: [], interactions: [] }
        input.scene.tags = 'landscape'
        expect(parsePainterDraft(JSON.stringify(input)).subjects).toEqual([])
    })

    it('does not allow a returned stale prompt override to bypass the newly compiled pose', () => {
        const input = plan()
        Object.assign(input.subjects[0], { prompt: 'old pose', locked: true })
        const draft = parsePainterDraft(JSON.stringify(input))
        expect(draft.subjects[0].prompt).toBeUndefined()
        expect(draft.subjects[0].locked).toBeUndefined()
        expect(draft.subjects[0].pose).toContain('Receives the cup')
    })

    it('drops first-person viewer relations before they become global prose or another actors actions', () => {
        const input = plan()
        input.scene = { tags: 'pov', location: 'A station platform.', framing: '', camera: '' }
        input.subjects[1].name = 'Viewer'
        const draft = parsePainterDraft(JSON.stringify(input), new Set(['viewer']))
        expect(draft.subjects.map(subject => subject.name)).toEqual(['Aria'])
        expect(draft.scene).toBe('pov\nA station platform.')
        expect(draft.subjects[0].pose).toBe('standing')
        expect(draft.subjects[0].clothing).toBe('blue coat, black boots')
    })

    it('keeps original participant indices when the excluded viewer precedes visible actors', () => {
        const input = plan()
        input.subjects.unshift(subject('Viewer'))
        input.interactions[0].source = 2
        input.interactions[0].target = 1
        const draft = parsePainterDraft(JSON.stringify(input), new Set(['viewer']))
        expect(draft.subjects.map(subject => subject.name)).toEqual(['Aria', 'Leon'])
        expect(draft.subjects[0].pose).toContain('Receives the cup')
        expect(draft.subjects[1].pose).toContain('Extends a cup')
    })

    it.each([-1, 2, 0.5, '0', null])('rejects an invalid interaction participant %s', source => {
        const input = plan()
        Object.assign(input.interactions[0], { source })
        expect(() => parsePainterDraft(JSON.stringify(input))).toThrow()
    })

    it.each([
        (input: ReturnType<typeof plan>) => { input.interactions[0].source = input.interactions[0].target },
        (input: ReturnType<typeof plan>) => { input.scene = { tags: '', location: '', framing: '', camera: '' } },
        (input: ReturnType<typeof plan>) => { input.scene.camera = 'x'.repeat(1201) },
        (input: ReturnType<typeof plan>) => { Object.assign(input.subjects[0], { pose: 'unstructured' }) },
        (input: ReturnType<typeof plan>) => { Object.assign(input, { version: 3 }) },
        (input: ReturnType<typeof plan>) => { Object.assign(input, { interactions: null }) },
    ])('rejects malformed plans before image generation (%#)', mutate => {
        const input = plan()
        mutate(input)
        expect(() => parsePainterDraft(JSON.stringify(input))).toThrow()
    })
})
