import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { createMarkdownNarrativeWiki, resolveMarkdownWikiWorkspace } from './risubard-markdown-wiki'
import { completeMemoryWorkspaceFork, forkMemoryWorkspace, replaceMemoryWorkspace, type MemoryForkReceipt } from './risubard-memory-fork'
import { validateImportConflicts, validateWikiPackage } from '../../src/ts/risubard/wikiTransferPackage'

interface Scope { userDataDirectory: string; characterId: string; chatId: string }

/** Called with the source and destination runtime queues held. */
export async function inheritWikiWorkspace(input: {
    userDataDirectory: string; characterId: string; sourceChatId: string; destinationChatId: string
}): Promise<MemoryForkReceipt> {
    const receipt = await forkMemoryWorkspace({ ...input, mode: 'copy' }, { wikiOnly: true })
    try {
        if (!receipt.sourceExists) throw new Error('이어받을 위키가 없습니다.')
        const wiki = createMarkdownNarrativeWiki(input.userDataDirectory)
        await wiki.detachInheritedSources(input.characterId, input.destinationChatId, input.sourceChatId)
        return receipt
    }
    catch (error) {
        await completeMemoryWorkspaceFork({ ...input, forkToken: receipt.forkToken, action: 'discard' })
        throw error
    }
}

/** Build the whole import privately, then publish through the existing replacement transaction. */
export async function importWikiWorkspace(input: Scope & { package: unknown }, options: {
    completeFork?: typeof completeMemoryWorkspaceFork
} = {}): Promise<{ imported: number }> {
    const completeFork = options.completeFork ?? completeMemoryWorkspaceFork
    const pack = validateWikiPackage(input.package)
    const recovery = resolveMarkdownWikiWorkspace(input.userDataDirectory, input.characterId, input.chatId).recoveryDirectory
    try {
        if ((await readdir(recovery)).length > 0) throw new Error('위키 리부트 복구를 완료하거나 취소한 뒤 들여와 주세요.')
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const wiki = createMarkdownNarrativeWiki(input.userDataDirectory)
    const before = await wiki.loadView(input.characterId, input.chatId)
    validateImportConflicts(pack, before.documents)
    const signature = (docs: typeof before.documents) => JSON.stringify(docs.map(doc => [doc.id, doc.relativePath, doc.contentHash]).sort())
    const stagingChatId = `transfer-${randomUUID()}`
    const staged = await forkMemoryWorkspace({ ...input, sourceChatId: input.chatId, destinationChatId: stagingChatId, mode: 'copy' })
    let replacement: MemoryForkReceipt | undefined
    let published = false
    let finalizationStarted = false
    try {
        for (const doc of pack.documents) {
            const saved = await wiki.saveManualDocument({
                characterId: input.characterId, chatId: stagingChatId,
                type: doc.type, title: doc.title, aliases: doc.aliases, markdown: doc.content,
                retrievalMetadata: doc.retrievalMetadata,
            })
            if (saved.contextMode !== doc.contextMode && doc.type !== 'scene') {
                await wiki.setDocumentContextMode({ characterId: input.characterId, chatId: stagingChatId, documentId: saved.id, contextMode: doc.contextMode, expectedContentHash: saved.contentHash })
            }
        }
        if (signature((await wiki.loadView(input.characterId, input.chatId)).documents) !== signature(before.documents)) {
            throw new Error('들여오는 동안 위키가 변경되었습니다. 다시 시도해 주세요.')
        }
        replacement = await replaceMemoryWorkspace({ ...input, sourceChatId: stagingChatId, destinationChatId: input.chatId })
        finalizationStarted = true
        const completion = { ...input, destinationChatId: input.chatId, forkToken: replacement.forkToken, action: 'finalize' as const }
        try { await completeFork(completion) }
        catch {
            // Publication may have succeeded before writing its completion receipt.
            // The existing transaction is idempotent only for the SAME action.
            try { await completeFork(completion) }
            catch { throw new Error('위키 들여오기 완료 기록을 확인하지 못했습니다. 위키를 새로 열어 반영 여부를 확인해 주세요.') }
        }
        published = true
        return { imported: pack.documents.length }
    }
    catch (error) {
        if (replacement && !published && !finalizationStarted) {
            await completeFork({ ...input, destinationChatId: input.chatId, forkToken: replacement.forkToken, action: 'discard' })
        }
        throw error
    }
    finally {
        // A temporary copy is not live user data. Publication success must not be
        // reported as failure solely because this disposable copy cannot be removed.
        await completeMemoryWorkspaceFork({ ...input, destinationChatId: stagingChatId, forkToken: staged.forkToken, action: 'discard' }).catch(() => undefined)
    }
}
