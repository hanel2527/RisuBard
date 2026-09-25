import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createTagIndex, highlightTagMatch, normalizeTagQuery, searchTagIndex } from './search';

const csv = [
    'long hair,0,900,null',
    'very long hair,0,800,null',
    'loose hair,0,700,null',
    '머리/긴 머리,0,900,long hair',
    '長い髪,0,900,long hair',
    'long locks,0,900,long hair',
    'blue eyes,0,600,null',
].join('\n');

describe('local tag search', () => {
    it('preserves source records, multilingual aliases and canonical redirect semantics', () => {
        const index = createTagIndex('\uFEFF' + csv + '\r\ninvalid\n');
        expect(searchTagIndex(index, '긴 머')[0]).toEqual({ word: '머리/긴 머리', category: 0, frequency: 900, redirect: 'long hair' });
        expect(searchTagIndex(index, '長い')[0].redirect).toBe('long hair');
        expect(searchTagIndex(index, 'long hair')[0].redirect).toBe('null');
        expect(searchTagIndex(index, 'long').map(tag => tag.word)).not.toContain('long locks');
    });

    it('normalizes Latin case, Korean syllables, old-style jamo and compound jamo', () => {
        expect(normalizeTagQuery('Blue Hair')).toBe('blue hair');
        expect(normalizeTagQuery('꽉')).toBe('ㄱㄱㅗㅏㄱ');
        expect(normalizeTagQuery('곽')).toBe(normalizeTagQuery('곽'));
        expect(normalizeTagQuery('긴 머')).toBe('ㄱㅣㄴ ㅁㅓ');
    });

    it('uses subsequences and abbreviation/gap scores before frequency', () => {
        const index = createTagIndex(csv);
        expect(searchTagIndex(index, 'LH').map(tag => tag.word)).toContain('long hair');
        expect(searchTagIndex(index, 'lh')[0].word).toBe('long hair');
        const rank = createTagIndex('amazing long hairstyle,0,9999,null\nlong hair,0,1,null');
        expect(searchTagIndex(rank, 'long')[0].word).toBe('long hair');
        expect(searchTagIndex(index, 'hair')[0].word).toBe('long hair');
        expect(searchTagIndex(index, 'xyz')).toEqual([]);
        expect(searchTagIndex(index, '')).toEqual([]);
        expect(searchTagIndex(index, 'hair', 2)).toHaveLength(2);
    });

    it('highlights subsequences with the original Korean and Japanese characters intact', () => {
        expect(highlightTagMatch('long hair', 'lh')).toEqual([
            { text: 'l', match: true }, { text: 'ong ', match: false },
            { text: 'h', match: true }, { text: 'air', match: false },
        ]);
        expect(highlightTagMatch('긴 머리', 'ㄱㅁ')).toEqual([
            { text: '긴', match: true }, { text: ' ', match: false },
            { text: '머', match: true }, { text: '리', match: false },
        ]);
        expect(highlightTagMatch('長い髪', '長い')).toEqual([{ text: '長い', match: true }, { text: '髪', match: false }]);
    });

    it('loads the shipped snapshot unchanged and resolves its real multilingual aliases', () => {
        const bytes = readFileSync('public/data/danbooru/db.csv');
        const metadata = JSON.parse(readFileSync('public/data/danbooru/metadata.json', 'utf8'));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(metadata.sha256);
        expect(bytes.length).toBe(metadata.bytes);
        const index = createTagIndex(bytes.toString('utf8'));
        expect(index).toHaveLength(metadata.records);
        expect(searchTagIndex(index, '긴 머')[0].redirect).toBe('long hair');
        expect(searchTagIndex(index, '神坂春姫')[0].redirect).toBe('kamisaka haruhi');
        expect(searchTagIndex(index, 'lh')[0].word).toBe('long hair');
        expect(searchTagIndex(index, 'a')).toHaveLength(64);
    });
});

describe('shared worker client', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

    it('reuses one worker, cancels pending requests and ignores stale replies', async () => {
        const workers: any[] = [];
        class FakeWorker {
            onmessage: (event: any) => void;
            onerror: () => void;
            messages: any[] = [];
            constructor() { workers.push(this); }
            postMessage(message: any) { this.messages.push(message); }
            terminate() {}
        }
        vi.stubGlobal('Worker', FakeWorker);
        const { searchTags } = await import('./client');
        const cancellation = new AbortController();
        const old = searchTags('lo', cancellation.signal);
        cancellation.abort();
        expect(await old).toEqual([]);
        const current = searchTags('long');
        expect(workers).toHaveLength(1);
        const worker = workers[0];
        const latest = worker.messages.at(-1);
        worker.onmessage({ data: { id: latest.id, results: [{ word: 'long hair' }] } });
        expect(await current).toEqual([{ word: 'long hair' }]);
        worker.onmessage({ data: { id: worker.messages[0].id, results: [{ word: 'obsolete' }] } });
    });

    it('fails open when workers cannot start', async () => {
        vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked'); } });
        const { searchTags } = await import('./client');
        expect(await searchTags('hair')).toEqual([]);
    });

    it('settles every editor independently after database loading fails', async () => {
        let worker: any;
        vi.stubGlobal('Worker', class {
            onmessage: (event: any) => void;
            constructor() { worker = this; }
            postMessage() {}
            terminate() {}
        });
        const { searchTags } = await import('./client');
        const first = searchTags('hair');
        const second = searchTags('eyes');
        worker.onmessage({ data: { id: 1, results: [], failed: true } });
        expect(await Promise.all([first, second])).toEqual([[], []]);
        expect(await searchTags('hair')).toEqual([]);
    });
});
