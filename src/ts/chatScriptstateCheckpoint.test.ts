import { describe, expect, it } from 'vitest'
import {
    attachScriptstateCheckpoint,
    getSwipeScriptstateCheckpoints,
    restoreScriptstateBeforeReroll,
    restoreScriptstateForPrefix,
    restoreSelectedSwipeScriptstate,
    selectResponseScriptstateBefore,
    snapshotChatScriptstate,
} from './chatScriptstateCheckpoint'

describe('chat script-state checkpoints', () => {
    it('restores the state that existed before a response when rerolling', () => {
        const chat = { scriptstate: { '$Likeability': '109' } }
        const message = {}
        attachScriptstateCheckpoint(
            message,
            { '$Likeability': '100' },
            chat.scriptstate,
        )

        expect(restoreScriptstateBeforeReroll(chat, message)).toBe(true)
        expect(chat.scriptstate).toEqual({ '$Likeability': '100' })
    })

    it('restores the state saved for the selected swipe', () => {
        const chat = { scriptstate: { '$Likeability': '109' } }
        const message = {
            swipeId: 0,
            scriptstateSwipeCheckpoints: [
                { before: { '$Likeability': '100' }, after: { '$Likeability': '103' } },
                { before: { '$Likeability': '100' }, after: { '$Likeability': '109' } },
            ],
        }

        expect(restoreSelectedSwipeScriptstate(chat, message)).toBe(true)
        expect(chat.scriptstate).toEqual({ '$Likeability': '103' })
        expect(message).toMatchObject({
            scriptstateCheckpoint: {
                before: { '$Likeability': '100' },
                after: { '$Likeability': '103' },
            },
        })
    })

    it('leaves a legacy message with no checkpoint unchanged', () => {
        const chat = { scriptstate: { '$Likeability': '120' } }
        const message = { swipeId: 0 }

        expect(restoreScriptstateBeforeReroll(chat, message)).toBe(false)
        expect(restoreSelectedSwipeScriptstate(chat, message)).toBe(false)
        expect(chat.scriptstate).toEqual({ '$Likeability': '120' })
        expect(getSwipeScriptstateCheckpoints(message, 1)).toEqual([null])
        expect(snapshotChatScriptstate(chat.scriptstate)).toEqual({ '$Likeability': '120' })
    })

    it('keeps the original response baseline when auto-continuing', () => {
        const beforeContinuation = { '$Likeability': '109' }
        const continuedResponse = {
            before: { '$Likeability': '100' },
            after: beforeContinuation,
        }

        expect(selectResponseScriptstateBefore(beforeContinuation, continuedResponse))
            .toEqual({ '$Likeability': '100' })
    })

    it('clears the active checkpoint when selecting a legacy swipe', () => {
        const chat = { scriptstate: { '$Likeability': '109' } }
        const message = {
            swipeId: 0,
            scriptstateCheckpoint: {
                before: { '$Likeability': '100' },
                after: { '$Likeability': '109' },
            },
            scriptstateSwipeCheckpoints: [null],
        }

        expect(restoreSelectedSwipeScriptstate(chat, message)).toBe(false)
        expect(message).not.toHaveProperty('scriptstateCheckpoint')
        expect(restoreScriptstateBeforeReroll(chat, message)).toBe(false)
        expect(chat.scriptstate).toEqual({ '$Likeability': '109' })
    })

    it('restores only the retained response state and keeps checkpoints immutable', () => {
        const chat = { scriptstate: { score: 300 } }
        const messages = [
            { role: 'char', scriptstateCheckpoint: { before: { score: 0 }, after: { score: 100 } } },
            { role: 'char', scriptstateCheckpoint: { before: { score: 100 }, after: { score: 300 } } },
        ]
        restoreScriptstateForPrefix(chat, messages.slice(0, 1), messages)
        expect(chat.scriptstate).toEqual({ score: 100 })
        chat.scriptstate.score = 999
        expect(messages[0].scriptstateCheckpoint.after).toEqual({ score: 100 })
    })

    it('restores the state before the first response when no response is retained', () => {
        const chat: { scriptstate?: { score: number } } = { scriptstate: { score: 300 } }
        const messages = [{ role: 'char', scriptstateCheckpoint: { before: null, after: { score: 300 } } }]
        restoreScriptstateForPrefix(chat, [], messages)
        expect(chat.scriptstate).toBeUndefined()
    })

    it('refuses an unrecorded historical prefix instead of inheriting future variables', () => {
        const chat = { scriptstate: { score: 300 } }
        const messages = [{ role: 'char' }, { role: 'char' }]
        expect(() => restoreScriptstateForPrefix(chat, messages.slice(0, 1), messages))
            .toThrow('체크포인트')
        expect(chat.scriptstate).toEqual({ score: 300 })
        restoreScriptstateForPrefix(chat, messages, messages)
        expect(chat.scriptstate).toEqual({ score: 300 })
    })
})
