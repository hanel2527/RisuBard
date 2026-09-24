import { describe, expect, it } from 'vitest'
import { PAINTER_STYLES } from './styles'

describe('public painter defaults', () => {
    it('never distributes personal artist, rendering, or negative prompts', () => {
        expect(PAINTER_STYLES.every(style => style.artist === '' && style.rendering === '' && style.negative === '')).toBe(true)
    })
    it('contains only the neutral default preset', () => {
        expect(PAINTER_STYLES.map(style => style.id)).toEqual(['default'])
    })
})
