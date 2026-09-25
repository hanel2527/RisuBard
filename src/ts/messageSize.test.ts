import { describe, expect, it } from 'vitest'
import { getMessageSize } from './messageSize'

describe('message size', () => {
    it('counts Korean and emoji as UTF-8 bytes, not UTF-16 code units', () => {
        expect(getMessageSize({data: '한🙂'})).toEqual({bodyBytes: 7, totalBytes: 18})
    })

    it('keeps recovery metadata separate from the body and leaves it intact', () => {
        const message = {data: 'a', scriptstateCheckpoint: {before: null, after: {translation: 'old'}}}
        const before = JSON.stringify(message)
        const size = getMessageSize(message)
        expect(size.bodyBytes).toBe(1)
        expect(size.totalBytes).toBeGreaterThan(12)
        expect(JSON.stringify(message)).toBe(before)
    })
})
