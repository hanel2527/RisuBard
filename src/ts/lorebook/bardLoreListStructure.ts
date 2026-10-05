import type { BardLoreEntry, BardLoreKind } from './bardLore'

const listTitle = /\b(?:list|roster|directory|catalog(?:ue)?|timeline|chronology)\b|목록|명부|도감|연표|연대기|타임라인/i
const property = /^(?:format|name|age|gender|sex|hair|eyes?|appearance|clothing|dress(?: and hair)?|personality|traits?|speech(?: pattern)?|dormitory|residence|usually found(?: at)?|location|affiliation|description|background|history|abilities|skills|weaknesses|likes|dislikes|notes?|이름|나이|성별|외모|머리|머리카락|눈|성격|특징|말투|소속|위치|설명|비고)\s*[:：]/i

export interface BardLoreListPart {
    name: string
    aliases: string[]
    start: number
    end: number
    content: string
    context: string[]
}

export function bardLoreListKind(entry: BardLoreEntry): BardLoreKind {
    const title = entry.comment
    if (/\b(?:npc|characters?|people)\b|인물|캐릭터/i.test(title)) return 'character'
    if (/\b(?:factions?|guilds?|organizations?)\b|세력|조직|길드/i.test(title)) return 'faction'
    if (/\b(?:items?|equipment|weapons?)\b|아이템|물품|장비|무기/i.test(title)) return 'item'
    return entry.bard.kind
}

export function hasBardLoreListTitle(entry: BardLoreEntry): boolean {
    return listTitle.test(entry.comment)
}

function names(text: string): string[] {
    let value = text.trim().replace(/^\*\*(.*?)\*\*/, '$1')
    if (!value || property.test(value)) return []
    // Remove the final metadata parentheses, preserving qualifiers inside names
    // such as Tom Riddle (Diary) / 톰 리들 (일기장 속 모습).
    const metadata = value.match(/\s+\((?:[^()]|\([^()]*\))*\)(?:\s*[:：].*)?\s*$/u)
    if (metadata?.index !== undefined && /\b(?:female|male|age|birth|professor|headmaster|instructor|librarian|healer|matron|caretaker|auror|father|mother)\b|\d{4}|남성|여성/iu.test(metadata[0])) value = value.slice(0, metadata.index)
    else value = value.split(/[:：]/u)[0]
    value = value.trim().replace(/\*\*/g, '')
    if (!value || value.length > 120 || /[.!?。！？]$/u.test(value)) return []
    return [...new Set(value.split(/\s*[/／]\s*/u).map(name => name.trim()).filter(Boolean))]
}

export function inspectBardLoreList(entry: BardLoreEntry): { parts: BardLoreListPart[]; unassigned: string } {
    if (entry.mode === 'folder' || entry.mode === 'child' || entry.bard.derivedFromId || !hasBardLoreListTitle(entry)) {
        return { parts: [], unassigned: entry.content }
    }
    const lines = [...entry.content.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)]
        .filter(match => match[0]).map(match => ({ text: match[0].replace(/[\r\n]+$/, ''), start: match.index!, end: match.index! + match[0].length }))
    const bullets = lines.flatMap((line, index) => {
        const match = line.text.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)(.+)$/u)
        return match ? [{ index, indent: match[1].length, body: match[2] }] : []
    })
    const depth = Math.min(...bullets.filter(item => !property.test(item.body)).map(item => item.indent))
    const entityBullets = bullets.filter(item => item.indent === depth && !property.test(item.body))
    const strong = entityBullets.filter(item => /^[^:：()]*[/／][^:：()]*/u.test(item.body)
        || /\([^)]*\b(?:female|male|birth|age)\b/iu.test(item.body))
    let starts = (strong.length >= 2 ? strong : entityBullets)
        .map(item => ({ index: item.index, aliases: names(item.body) })).filter(item => item.aliases.length > 0)
    const namedHeadings = lines.filter(line => /^#{1,6}\s/u.test(line.text)
        && !listTitle.test(line.text) && !property.test(line.text.replace(/^#+\s/u, '') + ':'))
    if (strong.length < 2 && starts.length >= 2 && namedHeadings.length >= 2) {
        return { parts: [], unassigned: entry.content }
    }
    // Named headings are supported when there are no entity bullets. Property
    // subheadings are retained inside the corresponding source slice.
    let headingDepth = 0
    if (starts.length < 2) {
        const headings = lines.flatMap((line, index) => {
            const match = line.text.match(/^(#{1,6})\s+(.+)$/u)
            return match && !listTitle.test(match[2]) && !property.test(match[2] + ':')
                ? [{ index, depth: match[1].length, aliases: names(match[2]) }] : []
        })
        const groups = new Map<number, typeof headings>()
        for (const heading of headings) groups.set(heading.depth, [...(groups.get(heading.depth) ?? []), heading])
        const group = [...groups.entries()].sort(([a], [b]) => b - a).find(([, items]) => items.length >= 2)
        if (group && starts.length === 0) {
            headingDepth = group[0]
            starts = group[1].filter(item => item.aliases.length > 0)
        }
    }
    const covered = new Set<number>()
    const contextLines = new Set<number>()
    const parts = starts.map((item, index): BardLoreListPart => {
        let last = starts[index + 1]?.index ?? lines.length
        for (let line = item.index + 1; line < last; line++) {
            const heading = lines[line].text.match(/^(#{1,6})\s/u)
            if (heading && (!headingDepth || heading[1].length <= headingDepth)) { last = line; break }
        }
        for (let line = item.index; line < last; line++) covered.add(line)
        const start = lines[item.index].start
        const end = last < lines.length ? lines[last].start : entry.content.length
        const stack: Array<{ depth: number; index: number }> = []
        for (let line = 0; line < item.index; line++) {
            const heading = lines[line].text.match(/^(#{1,6})\s+(.+)$/u)
            if (!heading) continue
            while (stack.length && stack.at(-1)!.depth >= heading[1].length) stack.pop()
            if ((!headingDepth || heading[1].length < headingDepth)
                && heading[2].trim().toLocaleLowerCase() !== entry.comment.trim().toLocaleLowerCase()) {
                stack.push({ depth: heading[1].length, index: line })
            }
        }
        for (const heading of stack) contextLines.add(heading.index)
        return { name: item.aliases[0], aliases: item.aliases, start, end,
            content: entry.content.slice(start, end).trimEnd(), context: stack.map(heading => lines[heading.index].text) }
    })
    const unassigned = lines.filter((line, index) => !covered.has(index)
        && line.text.trim() && !contextLines.has(index)
        && line.text.replace(/^#{1,6}\s/u, '').trim().toLocaleLowerCase() !== entry.comment.trim().toLocaleLowerCase()
        && !/^\s*(?:[-*+]\s+)?(?:format|형식)\s*[:：]/iu.test(line.text))
        .map(line => line.text).join('\n')
    return { parts, unassigned }
}

function estimatedItemCount(entry: BardLoreEntry, parts: BardLoreListPart[]): number {
    if (parts.length) return parts.length
    const fallback = entry.content.split(/\r?\n/).filter(line => {
        const body = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, '')
        return body !== line && !property.test(body)
    }).length
    const tableRows = entry.content.split(/\r?\n/).filter(line => /^\s*\|/u.test(line) && !/^\s*\|[\s:|\-]+$/u.test(line)).length
    const paragraphs = entry.content.split(/\r?\n\s*\r?\n/u).filter(part => part.trim()).length
    return Math.max(fallback, tableRows - 1, paragraphs, 1)
}

export function estimateBardLoreListOutput(entry: BardLoreEntry): number {
    if (!hasBardLoreListTitle(entry) || entry.bard.derivedFromId) return 512
    const count = estimatedItemCount(entry, inspectBardLoreList(entry).parts)
    return 512 + count * 384 + Math.ceil(entry.content.length / 3)
}

export function assessBardLoreBulkRisk(entry: BardLoreEntry, outputLimit: number) {
    if (!hasBardLoreListTitle(entry) || entry.bard.derivedFromId || entry.mode === 'folder' || entry.mode === 'child') return null
    const { parts } = inspectBardLoreList(entry)
    const itemCount = estimatedItemCount(entry, parts)
    const estimatedOutputTokens = estimateBardLoreListOutput(entry)
    // A visible default-selection recommendation, never an execution limit.
    const threshold = Math.min(8192, Math.max(1, outputLimit))
    if (itemCount < 2 || estimatedOutputTokens <= threshold) return null
    return { itemCount, estimatedOutputTokens }
}
