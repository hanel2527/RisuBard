import { describe, expect, it } from 'vitest'
import { decodeWikiVector, encodeWikiVector } from './wikiVectorCodec'

describe('wiki vector codec', () => {
    it('round-trips vectors in about a fifth of the JSON size', () => {
        const vector = Array.from({ length: 1536 }, (_, index) => Math.sin(index) * 0.05)
        const encoded = encodeWikiVector(vector)
        const decoded = decodeWikiVector(encoded)
        expect(decoded.legacy).toBe(false)
        expect(decoded.vector).toHaveLength(1536)
        decoded.vector!.forEach((value, index) => expect(value).toBeCloseTo(vector[index], 6))
        expect(encoded.byteLength * 4).toBeLessThan(new TextEncoder().encode(JSON.stringify(vector)).byteLength)
    })

    it('reads earlier JSON entries and marks them for rewriting', () => {
        const decoded = decodeWikiVector(new TextEncoder().encode('[0.25,-0.5,1]'))
        expect(decoded).toEqual({ vector: [0.25, -0.5, 1], legacy: true })
    })

    it('rejects damaged entries instead of returning a wrong vector', () => {
        const encoded = encodeWikiVector([1, 2, 3])
        expect(decodeWikiVector(encoded.subarray(0, encoded.byteLength - 1)).vector).toBeUndefined()
        expect(decodeWikiVector(new TextEncoder().encode('{"x":1}')).vector).toBeUndefined()
        expect(decodeWikiVector(new TextEncoder().encode('not json')).vector).toBeUndefined()
    })
})
