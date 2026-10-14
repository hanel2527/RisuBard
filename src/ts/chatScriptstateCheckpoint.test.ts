import { describe, expect, it } from 'vitest'
import {
    attachScriptstateCheckpoint,
    getSwipeScriptstateCheckpoints,
    restoreScriptstateBeforeReroll,
    restoreSelectedSwipeScriptstate,
    selectResponseScriptstateBefore,
    snapshotChatScriptstate,
} from './chatScriptstateCheckpoint'
import type { ChatScriptstateCheckpointMessage } from './chatScriptstateCheckpoint'

describe('chat script-state checkpoints', () => {
    it('restores the state that existed before a response when rerolling', () => {
        const chat = { scriptstate: { '$Likeability': '109' } }
        const message = {}
        attachScriptstateCheckpoint(
            [message],
            0,
            { '$Likeability': '100' },
            chat.scriptstate,
        )

        expect(restoreScriptstateBeforeReroll(chat, message)).toBe(true)
        expect(chat.scriptstate).toEqual({ '$Likeability': '100' })
    })

    it('keeps checkpoints only on the latest response', () => {
        const old = { before: { '$Likeability': '90' }, after: { '$Likeability': '100' } }
        const earlier = { data: 'earlier', scriptstateCheckpoint: old, scriptstateSwipeCheckpoints: [old, null] }
        const user = { data: 'user' }
        const latest = { data: 'latest' }
        const messages: Array<ChatScriptstateCheckpointMessage & { data: string }> = [earlier, user, latest]

        attachScriptstateCheckpoint(messages, 2, { '$Likeability': '100' }, { '$Likeability': '109' })

        expect(earlier).toEqual({ data: 'earlier' })
        expect(user).toEqual({ data: 'user' })
        expect(latest).toEqual({
            data: 'latest',
            scriptstateCheckpoint: { before: { '$Likeability': '100' }, after: { '$Likeability': '109' } },
        })
    })

    it('keeps the swipe checkpoints of the response being continued', () => {
        const swipes = [{ before: null, after: { '$Likeability': '103' } }, null]
        const latest = { swipeId: 1, scriptstateSwipeCheckpoints: swipes }

        attachScriptstateCheckpoint([{}, latest], 1, null, { '$Likeability': '109' })

        expect(latest.scriptstateSwipeCheckpoints).toBe(swipes)
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
})
