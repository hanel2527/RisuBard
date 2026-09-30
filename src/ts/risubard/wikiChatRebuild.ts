import { rebuildWikiForChat } from '../process/index.svelte'

export interface NarrativeRebuildInput {
    characterId: string
    chatId: string
    fromIndex: number
    onProgress?(event: {
        phase: 'rewinding' | 'turn' | 'finished' | 'stopped' | 'unavailable'
        index?: number
        total?: number
    }): void
}


/** Rebuild in the existing resumable reboot workspace; publish only on completion. */
export async function rebuildNarrativeAfterChatEdit(
    input: NarrativeRebuildInput
): Promise<void> {
    input.onProgress?.({ phase: 'rewinding' })
    const completed = await rebuildWikiForChat(
        input.characterId, input.chatId, input.fromIndex
    )
    input.onProgress?.({ phase: completed ? 'finished' : 'stopped' })
    if (!completed) {
        throw new Error('BardWiki 재구성이 완료되지 않았습니다. 리부트에서 재개할 수 있습니다.')
    }
}
