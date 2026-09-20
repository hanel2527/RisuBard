export type ChatScriptstate = Record<string, string | number | boolean>
export type ChatScriptstateSnapshot = ChatScriptstate | null

export interface ChatScriptstateCheckpoint {
    before: ChatScriptstateSnapshot
    after: ChatScriptstateSnapshot
}

export interface ChatScriptstateCarrier {
    scriptstate?: ChatScriptstate
}

export interface ChatScriptstateCheckpointMessage {
    swipeId?: number
    scriptstateCheckpoint?: ChatScriptstateCheckpoint
    scriptstateSwipeCheckpoints?: Array<ChatScriptstateCheckpoint | null>
}

export function snapshotChatScriptstate(state: ChatScriptstate | undefined): ChatScriptstateSnapshot {
    return state === undefined ? null : { ...state }
}

function cloneSnapshot(snapshot: ChatScriptstateSnapshot): ChatScriptstateSnapshot {
    return snapshot === null ? null : { ...snapshot }
}

function cloneCheckpoint(checkpoint: ChatScriptstateCheckpoint): ChatScriptstateCheckpoint {
    return {
        before: cloneSnapshot(checkpoint.before),
        after: cloneSnapshot(checkpoint.after),
    }
}

export function selectResponseScriptstateBefore(
    scriptstateBeforeSend: ChatScriptstateSnapshot,
    continuedResponse?: ChatScriptstateCheckpoint,
): ChatScriptstateSnapshot {
    return continuedResponse
        ? cloneSnapshot(continuedResponse.before)
        : cloneSnapshot(scriptstateBeforeSend)
}

function restoreChatScriptstate(chat: ChatScriptstateCarrier, snapshot: ChatScriptstateSnapshot): void {
    if(snapshot === null){
        delete chat.scriptstate
        return
    }
    chat.scriptstate = { ...snapshot }
}

export function attachScriptstateCheckpoint(
    message: ChatScriptstateCheckpointMessage,
    before: ChatScriptstateSnapshot,
    after: ChatScriptstateSnapshot,
): void {
    message.scriptstateCheckpoint = {
        before: cloneSnapshot(before),
        after: cloneSnapshot(after),
    }
}

export function restoreScriptstateBeforeReroll(
    chat: ChatScriptstateCarrier,
    message: ChatScriptstateCheckpointMessage,
): boolean {
    const checkpoint = message.scriptstateCheckpoint
    if(!checkpoint) return false
    restoreChatScriptstate(chat, checkpoint.before)
    return true
}

export function getSwipeScriptstateCheckpoints(
    message: ChatScriptstateCheckpointMessage,
    swipeCount: number,
): Array<ChatScriptstateCheckpoint | null> {
    const checkpoints = message.scriptstateSwipeCheckpoints
        ? message.scriptstateSwipeCheckpoints.map((checkpoint) => checkpoint ? cloneCheckpoint(checkpoint) : null)
        : []

    while(checkpoints.length < swipeCount){
        checkpoints.push(null)
    }

    if(!message.scriptstateSwipeCheckpoints && swipeCount === 1 && message.scriptstateCheckpoint){
        checkpoints[0] = cloneCheckpoint(message.scriptstateCheckpoint)
    }

    return checkpoints.slice(0, swipeCount)
}

export function restoreSelectedSwipeScriptstate(
    chat: ChatScriptstateCarrier,
    message: ChatScriptstateCheckpointMessage,
): boolean {
    const checkpoints = message.scriptstateSwipeCheckpoints
    const checkpoint = checkpoints
        ? checkpoints[message.swipeId ?? 0]
        : message.scriptstateCheckpoint
    if(!checkpoint) {
        delete message.scriptstateCheckpoint
        return false
    }

    const activeCheckpoint = cloneCheckpoint(checkpoint)
    message.scriptstateCheckpoint = activeCheckpoint
    restoreChatScriptstate(chat, activeCheckpoint.after)
    return true
}
