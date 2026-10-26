export type StoryBackupKind = 'working' | 'chat-edit' | 'manual' | 'turn' | 'wiki-edit' | 'import'
export type StoryWikiOutcome = 'applied' | 'unchanged' | 'kept' | 'failed' | 'cancelled'

export interface StoryChatDelta {
    baseSnapshotId: string | null
    order: string[]
    messages: Array<{ id: string; value: Record<string, unknown> }>
    state: Record<string, unknown>
}

export interface StoryBackupSummary {
    id: string
    parentId: string | null
    branchId: string
    wikiCommitId: string
    chatSnapshotId: string
    createdAt: string
    kind: StoryBackupKind
    turnCount: number
    anchorMessageId: string | null
    latestMessageId: string | null
    name?: string
}

export interface StoryBranchRef {
    id: string
    tipId: string
    name?: string
}

export interface StoryPendingWiki {
    operationId: string
    sourceBackupId: string
    sourceChatSnapshotId: string
    targetMessageId: string
    sourceMessageIds: string[]
    recoveryManifestHash: string
    parentCommitId: string
    epoch: number
    status: 'writing' | 'failed' | 'cancelled'
    error?: string
}

export interface StoryPendingCheckout {
    forkToken: string
    sourceChatId: string
    destinationChatId: string
    backupId: string
}

export interface StoryHistoryState {
    mode: 'legacy' | 'history'
    revision: number
    epoch: number
    headId: string | null
    branchId: string | null
    wikiCommitId: string | null
    workingSnapshotId: string | null
    quickSaveId: string | null
    anchorMessageId: string | null
    bindings: Record<string, string>
    pendingWiki: StoryPendingWiki | null
    pendingCheckout: StoryPendingCheckout | null
    branches: StoryBranchRef[]
    backups: StoryBackupSummary[]
}

export interface StoryHistoryIdentity {
    characterId: string
    chatId: string
}

export interface StoryCaptureInput extends StoryHistoryIdentity {
    operationId: string
    expectedRevision?: number
    kind: 'working' | 'chat-edit' | 'manual'
    delta: StoryChatDelta
    anchorMessageId?: string | null
}

export interface StoryBeginWikiInput extends StoryHistoryIdentity {
    operationId: string
    expectedRevision?: number
    sourceBackupId?: string
    targetMessageId: string
    sourceMessageIds: string[]
}

export interface StoryFinishWikiInput extends StoryHistoryIdentity {
    operationId: string
    outcome: StoryWikiOutcome
    error?: string
}

export interface StoryCheckoutInput extends StoryHistoryIdentity {
    backupId: string
    asNewChat?: boolean
    destinationChatId?: string
    expectedRevision?: number
}

export interface StoryCompleteCheckoutInput extends StoryHistoryIdentity {
    destinationChatId?: string
    forkToken: string
    action: 'finalize' | 'discard'
}
