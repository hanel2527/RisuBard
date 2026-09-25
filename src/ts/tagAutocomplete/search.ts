export interface TagSuggestion {
    word: string;
    category: number;
    frequency: number;
    /** The literal "null" denotes a canonical tag, matching the source CSV. */
    redirect: string;
}

interface IndexedTag {
    tag: TagSuggestion;
    normalized: string;
    shortened: string;
}
export type TagIndex = readonly IndexedTag[];

const initials = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const vowels = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const finals = 'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';
const compound: Record<string, string> = {
    ㅘ: 'ㅗㅏ', ㅙ: 'ㅗㅐ', ㅚ: 'ㅗㅣ', ㅝ: 'ㅜㅓ', ㅞ: 'ㅜㅔ', ㅟ: 'ㅜㅣ', ㅢ: 'ㅡㅣ',
    ㄳ: 'ㄱㅅ', ㄵ: 'ㄴㅈ', ㄶ: 'ㄴㅎ', ㄺ: 'ㄹㄱ', ㄻ: 'ㄹㅁ', ㄼ: 'ㄹㅂ', ㄽ: 'ㄹㅅ',
    ㄾ: 'ㄹㅌ', ㄿ: 'ㄹㅍ', ㅀ: 'ㄹㅎ', ㅄ: 'ㅂㅅ', ㄲ: 'ㄱㄱ', ㄸ: 'ㄷㄷ', ㅃ: 'ㅂㅂ', ㅆ: 'ㅅㅅ', ㅉ: 'ㅈㅈ',
};

function normalizeCharacter(char: string): string {
    const code = char.codePointAt(0)!;
    if (code >= 65 && code <= 90) return char.toLowerCase();
    if (code >= 0xac00 && code <= 0xd7a3) {
        const offset = code - 0xac00;
        return normalizeTagQuery(initials[Math.floor(offset / 588)] + vowels[Math.floor(offset % 588 / 28)] + (finals[offset % 28 - 1] ?? ''));
    }
    if (code >= 0x1100 && code <= 0x1112) char = initials[code - 0x1100];
    else if (code >= 0x1161 && code <= 0x1175) char = vowels[code - 0x1161];
    else if (code >= 0x11a8 && code <= 0x11c2) char = finals[code - 0x11a8];
    else if (code === 0x1140 || code === 0x11eb) char = 'ㅿ';
    else if (code === 0x114c || code === 0x11f0) char = 'ㆁ';
    else if (code === 0x1159 || code === 0x11f9) char = 'ㆆ';
    else if (code === 0x119e) char = 'ㆍ';
    return compound[char] ?? char;
}

/** SDStudio normalization deliberately keeps spaces and punctuation. */
export function normalizeTagQuery(word: string): string {
    let result = '';
    for (const char of word) result += normalizeCharacter(char);
    return result;
}

function shorten(word: string): string {
    if (/[가-힣]/.test(word)) {
        let result = '';
        for (const char of word) {
            const code = char.codePointAt(0)!;
            if (code >= 0xac00 && code <= 0xd7a3) result += normalizeCharacter(initials[Math.floor((code - 0xac00) / 588)]);
        }
        return result;
    }
    let result = '';
    let newWord = true;
    for (const char of word) {
        if (/\s/.test(char)) newWord = true;
        else if (newWord && char >= 'a' && char <= 'z') {
            result += char + ' ';
            newWord = false;
        }
    }
    return result;
}

/** Build once per dataset. Keep the original frequency-ordered source order. */
export function createTagIndex(csv: string): TagIndex {
    const index: IndexedTag[] = [];
    for (const line of csv.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const fields = line.split(',');
        if (fields.length !== 4 || !fields[0] || !fields[3]) continue;
        const category = Number(fields[1]);
        const frequency = Number(fields[2]);
        if (!Number.isInteger(category) || !Number.isFinite(frequency) || frequency < 0) continue;
        const tag = { word: fields[0], category, frequency, redirect: fields[3] };
        index.push({ tag, normalized: normalizeTagQuery(tag.word), shortened: shorten(tag.word) });
    }
    return index;
}

function isSubsequence(query: string, word: string): boolean {
    let offset = 0;
    for (let i = 0; i < word.length && offset < query.length; i++) {
        if (word[i] === query[offset]) offset++;
    }
    return offset === query.length;
}

// Same contiguous-run cost as SDStudio calcGapMatch, with rolling rows.
function gapScore(query: string, word: string): number {
    if (word.startsWith(query) || word.endsWith(query)) return 0;
    if (query.length > 64 || word.length > 64 || !isSubsequence(query, word)) return 1e9;
    let skipped = new Float64Array(word.length + 1);
    let matched = new Float64Array(word.length + 1).fill(1e9);
    for (let i = 0; i < query.length; i++) {
        const nextSkipped = new Float64Array(word.length + 1).fill(1e9);
        const nextMatched = new Float64Array(word.length + 1).fill(1e9);
        for (let j = 1; j <= word.length; j++) {
            if (query[i] === word[j - 1]) nextMatched[j] = Math.min(skipped[j - 1] + 1, matched[j - 1]);
            nextSkipped[j] = Math.min(nextSkipped[j - 1], nextMatched[j - 1]);
        }
        skipped = nextSkipped;
        matched = nextMatched;
    }
    return Math.min(skipped[word.length], matched[word.length]);
}

export function searchTagIndex(index: TagIndex, text: string, limit = 64): TagSuggestion[] {
    const query = normalizeTagQuery(text);
    if (!query || limit <= 0) return [];
    const candidates: IndexedTag[] = [];
    const canonical = new Set<string>();
    for (const item of index) {
        if (!isSubsequence(query, item.normalized)) continue;
        candidates.push(item);
        if (item.tag.redirect === 'null') canonical.add(item.tag.word);
        if (candidates.length >= 1600) break;
    }
    return candidates.filter(item => item.tag.redirect === 'null' || !canonical.has(item.tag.redirect))
        .map(item => ({ item, short: gapScore(query, item.shortened), full: gapScore(query, item.normalized) }))
        .sort((a, b) => a.short - b.short || a.full - b.full || b.item.tag.frequency - a.item.tag.frequency)
        .slice(0, Math.min(64, limit)).map(result => result.item.tag);
}

export function highlightTagMatch(word: string, query: string): { text: string; match: boolean }[] {
    const normalized = normalizeTagQuery(query);
    const chars = Array.from(word);
    let offset = 0;
    const result: { text: string; match: boolean }[] = [];
    for (const char of chars) {
        let match = false;
        for (const part of normalizeCharacter(char)) {
            if (offset < normalized.length && part === normalized[offset]) { offset++; match = true; }
        }
        const last = result.at(-1);
        if (last && last.match === match) last.text += char;
        else result.push({ text: char, match });
    }
    return result;
}
