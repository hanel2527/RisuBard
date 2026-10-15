// Character Assistant edits: the assistant proposes changes to one slot of a
// bot item with <edit> tags, the dock shows each as a card, and the user
// applies, skips or reverts it. A slot is one raw value (a field, a lore body,
// a regex OUT), never the annotated text the assistant reads, so an edit can
// not write material headers or line numbers into the bot.

import {
    CHARACTER_FIELDS,
    type AssistantCharacterSource,
    type AssistantLoreSource,
    type AssistantRegexSource,
    type CharacterFieldKey,
} from './characterAssistant'

export type AssistantEditSlot = 'text' | 'content' | 'key' | 'secondkey' | 'comment' | 'in' | 'out'

export type AssistantEditStatus = 'pending' | 'applied' | 'skipped' | 'failed' | 'reverted'

export interface AssistantEdit {
    id: string
    /** `bot:field:desc`, `bot:greeting:2`, `bot:lore:12`, `bot:regex:3`. */
    ref: string
    slot: AssistantEditSlot
    /** Item name when proposed, to find the item again after reordering. */
    name?: string
    /** How the card names the slot, e.g. "로어북 12번 `이름` 본문". */
    label: string
    /** Text to replace; absent means the whole slot. */
    find?: string
    replace: string
    status: AssistantEditStatus
    /** Why the edit could not be proposed, applied or reverted. */
    error?: string
    /** Slot value before applying, for revert. */
    previous?: string
    /** Slot value right after applying; revert checks nothing changed since. */
    applied?: string
}

export interface ParsedAssistantEdit {
    ref: string
    slot?: string
    find?: string
    replace: string
}

const EDIT_TAG = /<edit\s+ref\s*=\s*"([^"]{1,80})"(?:\s+slot\s*=\s*"([^"]{0,20})")?\s*>([\s\S]*?)<\/edit>/gi
const UNCLOSED_EDIT = /<edit\b[\s\S]*$/i
const FIND_TAG = /<find>\n?([\s\S]*?)\n?<\/find>/i
const REPLACE_TAG = /<replace>\n?([\s\S]*?)\n?<\/replace>/i

export function parseAssistantEdits(text: string): ParsedAssistantEdit[] {
    const edits: ParsedAssistantEdit[] = []
    for (const match of text.matchAll(EDIT_TAG)) {
        const body = match[3]
        const replace = REPLACE_TAG.exec(body)
        if (!replace) continue
        const find = FIND_TAG.exec(body)
        const slot = match[2]?.trim()
        edits.push({
            ref: match[1].trim(),
            ...(slot ? { slot } : {}),
            ...(find ? { find: find[1] } : {}),
            replace: replace[1],
        })
    }
    return edits
}

/** Removes edit tags from a reply, including one still streaming. */
export function stripAssistantEdits(text: string): string {
    return text.replace(EDIT_TAG, '').replace(UNCLOSED_EDIT, '').replace(/\n{3,}/g, '\n\n').trim()
}

// ---------------------------------------------------------------------------
// Slots

const SLOT_LABELS: Record<AssistantEditSlot, string> = {
    text: '', content: '본문', key: '키', secondkey: '보조 키', comment: '이름', in: 'IN', out: 'OUT',
}

const KIND_SLOTS: Record<string, AssistantEditSlot[]> = {
    field: ['text'],
    greeting: ['text'],
    lore: ['content', 'key', 'secondkey', 'comment'],
    regex: ['in', 'out', 'comment'],
}

const DEFAULT_SLOTS: Record<string, AssistantEditSlot | undefined> = {
    field: 'text', greeting: 'text', lore: 'content',
}


function loreName(entry: AssistantLoreSource): string {
    return (entry.comment?.trim() || entry.key?.split(',')[0]?.trim() || '').slice(0, 80)
}

function regexName(script: AssistantRegexSource): string {
    return (script.comment?.trim() ?? '').slice(0, 80)
}

function quoteName(name: string): string {
    return name ? ` \`${name.replaceAll('`', "'")}\`` : ''
}

interface SlotHandle {
    label: string
    name?: string
    get: () => string
    set: (value: string) => void
    /** Ref and name of the item now, after a key or name edit renamed it. */
    locate?: () => { ref: string; name: string }
}

class EditError extends Error {}

function isLuaTriggers(bot: AssistantCharacterSource): boolean {
    const type = bot.triggerscript?.[0]?.effect?.[0]?.type
    return type === 'triggerlua' || type === 'triggercode'
}

function fieldHandle(bot: AssistantCharacterSource, key: CharacterFieldKey): SlotHandle {
    const label = `\`${CHARACTER_FIELDS.find((field) => field.key === key)!.label}\` 필드`
    if (key === 'depthPrompt') {
        return {
            label,
            get: () => bot.depth_prompt?.prompt ?? '',
            set: (value) => { bot.depth_prompt = { depth: bot.depth_prompt?.depth ?? 0, prompt: value } },
        }
    }
    if (key === 'lua') {
        if (!isLuaTriggers(bot)) throw new EditError('이 봇은 Lua 트리거를 쓰지 않습니다.')
        const effect = bot.triggerscript![0].effect![0] as { code?: string }
        return { label, get: () => effect.code ?? '', set: (value) => { effect.code = value } }
    }
    const record = bot as Record<string, unknown>
    return { label, get: () => typeof record[key] === 'string' ? record[key] as string : '', set: (value) => { record[key] = value } }
}

/** Finds the numbered item again when the list was reordered since the edit was proposed. */
function locate<T>(items: T[] | undefined, no: number, name: string | undefined, nameOf: (item: T) => string): T {
    const list = items ?? []
    const direct = list[no - 1]
    if (direct && (name === undefined || nameOf(direct) === name)) return direct
    const named = name ? list.filter((item) => nameOf(item) === name) : []
    if (named.length === 1) return named[0]
    throw new EditError(name ? `'${name}' 항목을 찾지 못했습니다. 이름이 바뀌었거나 삭제됐을 수 있습니다.` : '항목을 찾지 못했습니다.')
}

function slotHandle(bot: AssistantCharacterSource, ref: string, slot: AssistantEditSlot, name?: string): SlotHandle {
    const [scope, kind, id] = ref.split(':')
    if (scope !== 'bot') throw new EditError('지금 다듬는 봇의 항목만 수정할 수 있습니다.')
    if (!KIND_SLOTS[kind]) throw new EditError(kind === 'trigger' ? '블록 트리거는 수정할 수 없습니다.' : '수정할 수 없는 항목입니다.')
    if (!KIND_SLOTS[kind].includes(slot)) throw new EditError(`이 항목에는 '${slot}' 칸이 없습니다.`)
    if (kind === 'field') {
        // CHARACTER_FIELDS comes from a module that imports this one; read it at call time.
        if (!CHARACTER_FIELDS.some((field) => field.key === id)) throw new EditError('목록에 없는 필드입니다.')
        return fieldHandle(bot, id as CharacterFieldKey)
    }
    const no = Number(id)
    if (!Number.isInteger(no) || no < 1) throw new EditError('항목 번호가 잘못됐습니다.')
    if (kind === 'greeting') {
        const greetings = bot.alternateGreetings ?? []
        if (no > greetings.length) throw new EditError('추가 인사말을 찾지 못했습니다.')
        return { label: `추가 인사말 ${no}번`, get: () => greetings[no - 1] ?? '', set: (value) => { greetings[no - 1] = value } }
    }
    if (kind === 'lore') {
        const entry = locate(bot.globalLore, no, name, loreName)
        if (entry.mode === 'folder') throw new EditError('로어북 폴더는 수정할 수 없습니다.')
        const field = slot as 'content' | 'key' | 'secondkey' | 'comment'
        const itemNo = (bot.globalLore ?? []).indexOf(entry) + 1
        return {
            label: `로어북 ${itemNo}번${quoteName(loreName(entry))} ${SLOT_LABELS[slot]}`,
            name: loreName(entry),
            get: () => entry[field] ?? '',
            set: (value) => { entry[field] = value },
            locate: () => ({ ref: `bot:lore:${(bot.globalLore ?? []).indexOf(entry) + 1}`, name: loreName(entry) }),
        }
    }
    const script = locate(bot.customscript, no, name, regexName)
    const field = slot as 'in' | 'out' | 'comment'
    const itemNo = (bot.customscript ?? []).indexOf(script) + 1
    return {
        label: `정규식 ${itemNo}번${quoteName(regexName(script))} ${SLOT_LABELS[slot]}`,
        name: regexName(script),
        get: () => script[field] ?? '',
        set: (value) => { script[field] = value },
        locate: () => ({ ref: `bot:regex:${(bot.customscript ?? []).indexOf(script) + 1}`, name: regexName(script) }),
    }
}

function countOccurrences(text: string, find: string): number {
    let count = 0
    for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + find.length)) count++
    return count
}

function replaced(current: string, edit: Pick<AssistantEdit, 'find' | 'replace'>): string {
    if (edit.find === undefined) return edit.replace
    if (!edit.find) throw new EditError('찾을 부분이 비어 있습니다.')
    const count = countOccurrences(current, edit.find)
    if (count === 0) throw new EditError('찾을 부분이 지금 본문에 없습니다. 이미 바뀌었거나 원문과 다르게 옮겨졌습니다.')
    if (count > 1) throw new EditError(`찾을 부분이 본문에 ${count}번 나옵니다. 한 곳만 가리키도록 더 길게 옮겨야 합니다.`)
    const at = current.indexOf(edit.find)
    return current.slice(0, at) + edit.replace + current.slice(at + edit.find.length)
}

function errorText(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Turns parsed tags into cards. Each is checked against the bot as it is now;
 * one that could not apply arrives as a failed card with the reason.
 */
export function prepareAssistantEdits(bot: AssistantCharacterSource, parsed: ParsedAssistantEdit[], newId: () => string): AssistantEdit[] {
    return parsed.map((item) => {
        const kind = item.ref.split(':')[1] ?? ''
        const slot = (item.slot || DEFAULT_SLOTS[kind] || '') as AssistantEditSlot
        const edit: AssistantEdit = { id: newId(), ref: item.ref, slot, label: item.ref, replace: item.replace, status: 'pending' }
        if (item.find !== undefined) edit.find = item.find
        try {
            if (!slot) throw new EditError('어느 칸을 고칠지 slot이 없습니다.')
            const handle = slotHandle(bot, item.ref, slot)
            edit.label = handle.label
            if (handle.name !== undefined) edit.name = handle.name
            if (replaced(handle.get(), edit) === handle.get()) throw new EditError('바꿔도 본문이 그대로입니다.')
        }
        catch (cause) {
            edit.status = 'failed'
            edit.error = errorText(cause)
        }
        return edit
    })
}

/** Applies a pending edit to the bot. Returns the edit with its new status. */
export function applyAssistantEdit(bot: AssistantCharacterSource, edit: AssistantEdit): AssistantEdit {
    try {
        const handle = slotHandle(bot, edit.ref, edit.slot, edit.name)
        const previous = handle.get()
        const next = replaced(previous, edit)
        handle.set(next)
        const result: AssistantEdit = { ...edit, status: 'applied', previous, applied: next, label: handle.label }
        delete result.error
        // A key or name edit can rename the item; follow it so revert finds it.
        if (handle.locate) Object.assign(result, handle.locate())
        return result
    }
    catch (cause) {
        return { ...edit, error: errorText(cause) }
    }
}

/** Puts the slot back as it was, unless something changed it after applying. */
export function revertAssistantEdit(bot: AssistantCharacterSource, edit: AssistantEdit, force = false): AssistantEdit {
    try {
        if (edit.status !== 'applied' || edit.previous === undefined) throw new EditError('적용한 수정만 되돌릴 수 있습니다.')
        const handle = slotHandle(bot, edit.ref, edit.slot, edit.name)
        if (!force && handle.get() !== edit.applied) throw new EditError('적용한 뒤 이 칸이 다시 바뀌었습니다.')
        handle.set(edit.previous)
        const result: AssistantEdit = { ...edit, status: 'reverted' }
        delete result.error
        if (handle.locate) Object.assign(result, handle.locate())
        return result
    }
    catch (cause) {
        return { ...edit, error: errorText(cause) }
    }
}

/** True when revert stopped only because the slot changed after applying. */
export function isRevertConflict(edit: AssistantEdit): boolean {
    return edit.status === 'applied' && edit.error === '적용한 뒤 이 칸이 다시 바뀌었습니다.'
}

export const EDIT_STATUS_NAMES: Record<AssistantEditStatus, string> = {
    pending: '아직 결정하지 않음', applied: '적용됨', skipped: '사용자가 건너뜀', failed: '실패', reverted: '적용했다가 되돌림',
}

/** What became of a reply's edits, for the assistant's next turn. */
export function formatEditResults(edits: AssistantEdit[]): string {
    if (edits.length === 0) return ''
    const lines = edits.map((edit) => {
        const reason = edit.error ? ` (${edit.error})` : ''
        return `- ${edit.ref}${edit.slot === 'text' ? '' : ` ${edit.slot}`}: ${EDIT_STATUS_NAMES[edit.status]}${reason}`
    })
    return `<edit_results>\n${lines.join('\n')}\n</edit_results>`
}

export function normalizeAssistantEdits(value: unknown): AssistantEdit[] | undefined {
    if (!Array.isArray(value)) return undefined
    const edits = value.filter((edit): edit is AssistantEdit =>
        !!edit && typeof edit === 'object'
        && typeof edit.id === 'string' && typeof edit.ref === 'string' && typeof edit.slot === 'string'
        && typeof edit.replace === 'string' && typeof edit.status === 'string' && edit.status in EDIT_STATUS_NAMES)
    return edits.length > 0 ? edits : undefined
}

export function characterAssistantEditGuide(): string {
    return `수정 제안:
- 고칠 곳이 분명하면 bot 범위의 항목은 아래 <edit> 태그로 제안한다. 앱이 태그를 수정 카드로 바꾸고, 사용자가 카드에서 적용하거나 건너뛴다. 태그로 제안한 수정은 본문에 코드 블록으로 다시 쓰지 않는다.
  <edit ref="bot:lore:12" slot="content">
  <find>
  원문에서 바꿀 부분을 글자 그대로 옮긴 것
  </find>
  <replace>
  새 내용
  </replace>
  </edit>
- <find>는 그 칸의 원문에 정확히 한 번 나오는 부분이다. 줄 앞의 "12| " 표기와 "이름:", "키:", "본문:", "IN:", "OUT:", "깊이:" 같은 자료 머리말은 원문이 아니므로 넣지 않는다. 같은 문장이 여러 번 나오면 앞뒤 줄을 더 포함한다. 본문을 읽지 않은 칸은 고치지 않는다.
- <find>를 빼면 칸 전체를 <replace>로 바꾼다. 키, 이름, 정규식 IN처럼 짧은 칸이나 비어 있는 필드에만 쓴다. Lua와 긴 필드는 바꿀 부분만 찾아 바꾼다.
- slot: 필드와 추가 인사말은 쓰지 않는다. 로어북은 content(본문, 기본값), key(키), secondkey(보조 키), comment(이름). 정규식은 in, out, comment(이름) 중 하나를 꼭 쓴다.
- 비어 있어 목차에 없는 필드도 ref="bot:field:키"로 채울 수 있다. 필드 키: ${CHARACTER_FIELDS.map((field) => `${field.key}(${field.label})`).join(', ')}.
- 한 답변에 여러 <edit>를 써도 된다. 같은 칸을 여러 번 고치면 서로 겹치지 않게 한다. <edit>는 <read>, <search>와 한 응답에 섞지 않는다.
- 태그로 고칠 수 없는 것: ref, 모듈, 프리셋, 블록 트리거, 로어북 폴더, 항목 추가와 삭제, 활성 방식과 순서 같은 설정. 이런 수정은 칸 하나 단위로 코드 블록에 담아 보여 주고 사용자가 직접 반영하게 한다.
- 태그 밖에서는 무엇을 왜 바꾸는지 짧게 설명한다. 적용은 사용자가 하므로 적용했다고 말하지 않는다.
- 앞선 제안이 어떻게 됐는지는 대화 기록의 <edit_results>로 알려 준다. 적용된 수정은 지금 목차와 자료에 이미 반영되어 있다. 실패한 제안은 이유를 보고 고쳐서 다시 제안한다.`
}

/** The slot's value now, or null when the item can no longer be found. */
export function readAssistantEditSlot(bot: AssistantCharacterSource, edit: AssistantEdit): string | null {
    try {
        return slotHandle(bot, edit.ref, edit.slot, edit.name).get()
    }
    catch {
        return null
    }
}
