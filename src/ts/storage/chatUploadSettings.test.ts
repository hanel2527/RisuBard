import { expect, test } from 'vitest'
import { normalizeChatUploadChunkMiB } from './chatUploadSettings'

test.each([
    [undefined, 8], [null, 8], ['', 8], [NaN, 8], [Infinity, 8], [true, 8],
    [0, 1], [-3, 1], [1, 1], [8, 8], ['16', 16], [16.9, 16], [64, 64], [100, 64],
])('normalizes a saved or edited chunk setting %s to %s MiB', (value, expected) => {
    expect(normalizeChatUploadChunkMiB(value)).toBe(expected)
})
