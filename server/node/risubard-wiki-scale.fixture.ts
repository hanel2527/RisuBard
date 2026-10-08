import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { resolveMarkdownWikiWorkspace } from './risubard-markdown-wiki'

// Synthetic long-chat data shared by the server and client scale benchmarks.
export const scaleCharacterId = 'bench-character'
export const scaleChatId = 'bench-chat'
export const scaleNames = ['아리아', '세레스', '카일', '노아', '리엔', '바르트', '이솔데', '헤일',
    '미라', '로웬', '테오', '시엘', '에단', '루나', '그레이', '하르트']
export const scalePlaces = ['고아원', '성당 지하', '북쪽 성문', '항구 창고', '왕립 도서관', '숲의 제단',
    '시계탑', '사제단 본부', '폐허가 된 마을', '수도원']
const verbs = ['조사했다', '숨겼다', '고백했다', '추궁했다', '도망쳤다', '약속했다',
    '배신했다', '되찾았다', '목격했다', '봉인했다']

export const scaleCanonicalFolders = [
    ['characters', 'character'], ['locations', 'location'], ['items', 'item'],
    ['concepts', 'concept'], ['notes', 'other'],
] as const

export function scaleSizes(fallback = '300,1000,3000'): number[] {
    return (process.env.RISUBARD_SCALE_TURNS ?? fallback)
        .split(',').map(Number).filter((value) => Number.isSafeInteger(value) && value > 0)
}

function random(seed: number) {
    let state = seed >>> 0
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0
        return state / 2 ** 32
    }
}

function sentence(next: () => number, index: number): string {
    const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]
    return `${pick(scaleNames)}는 ${pick(scalePlaces)}에서 ${pick(scaleNames)}와 함께 단서 ${index}번을 ${pick(verbs)}. `
        + `그 뒤 ${pick(scaleNames)}의 태도가 달라졌고 ${pick(scalePlaces)}의 문이 ${Math.floor(next() * 90) + 10}분 뒤 열렸다.`
}

export function scaleParagraphs(seed: number, count: number, perParagraph: number): string {
    const next = random(seed)
    return Array.from({ length: count }, (_, paragraph) =>
        Array.from({ length: perParagraph }, (_, item) =>
            sentence(next, seed * 100 + paragraph * 10 + item)).join(' ')
    ).join('\n\n')
}

export function scaleCanonicalCount(turns: number): number {
    return Math.max(30, Math.round(turns / 5))
}

export function scaleCanonicalTitles(turns: number): string[] {
    return Array.from({ length: scaleCanonicalCount(turns) }, (_, index) =>
        `${scaleNames[index % scaleNames.length]} ${index}`)
}

// One user (~0.3 KB) and one assistant (~2.5 KB, 8 paragraphs) message per turn.
export function buildScaleMessages(turns: number) {
    return Array.from({ length: turns }, (_, turn) => [
        { role: 'user', chatId: `user-${turn}`, data: scaleParagraphs(50_000 + turn, 1, 1) },
        { role: 'char', chatId: `assistant-${turn}`, data: scaleParagraphs(60_000 + turn, 8, 2) },
    ]).flat()
}

function frontmatter(input: {
    id: string
    type: string
    created: string
    sources: string[]
    links: string[]
}): string {
    return [
        '---',
        `id: ${JSON.stringify(input.id)}`,
        `type: ${input.type}`,
        'status: active',
        `created: ${JSON.stringify(input.created)}`,
        `updated: ${JSON.stringify(input.created)}`,
        `authoring: ${input.type === 'event' ? 'automatic' : 'ai-assisted'}`,
        'context: auto',
        'aliases:',
        'source_messages:',
        ...input.sources.map((id) => `  - ${JSON.stringify(id)}`),
        'links:',
        ...input.links.map((link) => `  - ${JSON.stringify(link)}`),
        '---',
        '',
    ].join('\n')
}

// Events: one per turn (~1.4 KB). Canonicals: max(30, turns / 5) (~4 KB),
// each with two history revisions that the view never reads but saves copy.
export async function buildScaleFixture(
    root: string,
    turns: number,
    characterId = scaleCharacterId,
    chatId = scaleChatId
): Promise<void> {
    const workspace = resolveMarkdownWikiWorkspace(root, characterId, chatId)
    const canonicalTitles = scaleCanonicalTitles(turns)
    const canonicalCount = canonicalTitles.length
    const base = Date.UTC(2026, 0, 1)
    const writes: Promise<void>[] = []
    const write = async (path: string, contents: string) => {
        await fs.mkdir(join(path, '..'), { recursive: true })
        await fs.writeFile(path, contents, 'utf8')
    }
    for (let turn = 0; turn < turns; turn++) {
        const title = `사건 ${turn}: ${scalePlaces[turn % scalePlaces.length]}의 밤`
        const links = [canonicalTitles[turn % canonicalCount],
            canonicalTitles[(turn * 7 + 3) % canonicalCount]]
        writes.push(write(join(workspace.eventsDirectory, `turn-${String(turn).padStart(6, '0')}.md`),
            frontmatter({
                id: `event.bench-${turn}`, type: 'event',
                created: new Date(base + turn * 60_000).toISOString(),
                sources: [`user-${turn}`, `assistant-${turn}`], links,
            }) + `## ${title}\n\n### 이야기 요약\n\n${scaleParagraphs(turn + 1, 3, 2).split('\n\n').map((line) => `- ${line}`).join('\n')}\n\n### 관련 문서\n\n`
                + links.map((link) => `- [[${link}]]`).join('\n') + '\n'))
    }
    canonicalTitles.forEach((title, index) => {
        const [folder, type] = scaleCanonicalFolders[index % scaleCanonicalFolders.length]
        const id = `${type}.bench-${index}`
        const body = `## ${title}\n\n### 현재 상태\n\n${scaleParagraphs(10_000 + index, 4, 3)}\n\n`
            + `### 주요 전환\n\n${scaleParagraphs(20_000 + index, 2, 2)}\n`
        const contents = frontmatter({
            id, type, created: new Date(base).toISOString(),
            sources: Array.from({ length: Math.min(96, Math.ceil(turns / canonicalCount)) },
                (_, item) => `assistant-${(index + item * canonicalCount) % turns}`),
            links: [canonicalTitles[(index + 1) % canonicalCount]],
        }) + body
        writes.push(write(join(workspace.directory, folder, `bench-${index}.md`), contents))
        for (let revision = 0; revision < 2; revision++) {
            writes.push(write(join(workspace.directory, '.risubard-history', id, `rev-${revision}.md`), contents))
        }
    })
    await Promise.all(writes)
}
