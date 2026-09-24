import type { PainterStyle } from './types'

// Public defaults contain no artist or style prompts. Personal presets belong to user data.
export const PAINTER_STYLES: PainterStyle[] = [
    { id: 'default', name: '기본', artist: '', rendering: '', negative: '',
        steps: 28, scale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral' },
]
