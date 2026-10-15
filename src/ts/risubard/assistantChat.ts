// Conversation helpers shared by the Prompt Assistant and the Character
// Assistant docks: forking, copying and saving a conversation work the same
// way in both, whatever material each assistant reads.

export interface AssistantChatMessage {
    id: string
    role: 'user' | 'assistant'
    text: string
    failed?: boolean
}

export interface AssistantFork<T extends AssistantChatMessage> {
    messages: T[]
    /** A forked question goes back to the input box so it can be edited and resent. */
    draft: string
}

/**
 * Messages a fork keeps. From a reply: everything up to and including it.
 * From a question: everything before it, with the question returned as a draft.
 */
export function forkAssistantMessages<T extends AssistantChatMessage>(messages: T[], messageId: string): AssistantFork<T> | null {
    const index = messages.findIndex((message) => message.id === messageId)
    if (index < 0) return null
    const target = messages[index]
    const kept = target.role === 'user' ? messages.slice(0, index) : messages.slice(0, index + 1)
    return {
        messages: kept.map((message) => structuredClone(message)),
        draft: target.role === 'user' ? target.text : '',
    }
}

export function formatAssistantTimestamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `프롬프트 비서 - 이름 - 2026-10-11_0905.md` style file name. */
export function assistantExportFileName(assistantName: string, projectName: string, date: Date): string {
    const safe = projectName.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || '프로젝트'
    return `${assistantName} - ${safe} - ${formatAssistantTimestamp(date).replace(' ', '_').replace(':', '')}.md`
}

export interface AssistantMarkdownInput<T extends AssistantChatMessage> {
    title: string
    /** `- 프리셋: 이름` style lines between the title and the messages. */
    facts: string[]
    messages: T[]
    /** A line in italics under a message heading, such as what it carried. */
    note?: (message: T) => string
}

/** The whole conversation as Markdown, with a rule between messages for reading. */
export function formatAssistantMarkdown<T extends AssistantChatMessage>(input: AssistantMarkdownInput<T>): string {
    const parts = [`# ${input.title}`, input.facts.join('\n')]
    for (const message of input.messages) {
        const heading = message.role === 'user' ? '## 나' : message.failed ? '## 비서 (응답 실패)' : '## 비서'
        const label = input.note?.(message) ?? ''
        parts.push(`---\n\n${heading}${label ? `\n\n_${label}_` : ''}\n\n${message.text.trim()}`)
    }
    return parts.join('\n\n') + '\n'
}

export async function copyAssistantText(text: string) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        return
    }
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    if (!copied) throw new Error('copy failed')
}
