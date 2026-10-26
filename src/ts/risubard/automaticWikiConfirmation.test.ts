import { describe, expect, test } from 'vitest'
import { shouldAutomaticallyConfirmNarrativeTurn } from './automaticWikiConfirmation'

describe('automatic BardWiki confirmation', () => {
    test('remains enabled by default and can be disabled explicitly', () => {
        expect(shouldAutomaticallyConfirmNarrativeTurn(undefined)).toBe(true)
        expect(shouldAutomaticallyConfirmNarrativeTurn(true)).toBe(true)
        expect(shouldAutomaticallyConfirmNarrativeTurn(false)).toBe(false)
    })

})
