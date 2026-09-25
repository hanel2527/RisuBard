import { createTagIndex, searchTagIndex } from './search';
import type { TagIndex } from './search';

let indexPromise: Promise<TagIndex> | undefined;
const queued = new Map<number, string>();

// Fetch, parse and normalize once, off the editor's main thread.
function loadIndex(url: string): Promise<TagIndex> {
    return indexPromise ??= fetch(url).then(response => {
        if (!response.ok) throw new Error('Tag database unavailable');
        return response.text();
    }).then(csv => {
        const index = createTagIndex(csv);
        if (!index.length) throw new Error('Tag database is empty');
        return index;
    });
}

self.onmessage = async (event: MessageEvent<{ id?: number; query?: string; url?: string; cancel?: number }>) => {
    const { id, query, url, cancel } = event.data;
    if (cancel !== undefined) { queued.delete(cancel); return; }
    if (id === undefined || !query || !url) return;
    queued.set(id, query);
    try {
        const index = await loadIndex(url);
        if (!queued.has(id)) return;
        queued.delete(id);
        self.postMessage({ id, results: searchTagIndex(index, query) });
    } catch {
        queued.delete(id);
        self.postMessage({ id, results: [], failed: true });
    }
};
