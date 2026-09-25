import type { TagSuggestion } from './search';

let worker: Worker | undefined;
let unavailable = false;
let nextId = 0;
const pending = new Map<number, (results: TagSuggestion[]) => void>();

function failOpen() {
    unavailable = true;
    worker?.terminate();
    worker = undefined;
    for (const resolve of pending.values()) resolve([]);
    pending.clear();
}

function getWorker(): Worker | undefined {
    if (unavailable) return;
    if (worker) return worker;
    try {
        worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ id: number; results: TagSuggestion[]; failed?: boolean }>) => {
            if (event.data.failed) { failOpen(); return; }
            pending.get(event.data.id)?.(event.data.results);
        };
        worker.onerror = failOpen;
        worker.onmessageerror = failOpen;
        return worker;
    } catch { failOpen(); }
}

/** Editors own AbortControllers and version checks; only data/index are shared. */
export function searchTags(query: string, signal?: AbortSignal): Promise<TagSuggestion[]> {
    if (!query || signal?.aborted) return Promise.resolve([]);
    const target = getWorker();
    if (!target) return Promise.resolve([]);
    // Bound outstanding work even if a consumer forgets to abort an old request.
    if (pending.size >= 64) {
        const oldest = pending.keys().next().value!;
        pending.get(oldest)?.([]);
        target.postMessage({ cancel: oldest });
    }
    return new Promise(resolve => {
        const id = ++nextId;
        const finish = (results: TagSuggestion[]) => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
            pending.delete(id);
            resolve(results);
        };
        const abort = () => { finish([]); target.postMessage({ cancel: id }); };
        const timeout = setTimeout(() => { finish([]); target.postMessage({ cancel: id }); }, 30_000);
        pending.set(id, finish);
        signal?.addEventListener('abort', abort, { once: true });
        try {
            target.postMessage({ id, query, url: new URL(`${import.meta.env.BASE_URL}data/danbooru/db.csv`, document.baseURI).href });
        } catch { failOpen(); }
    });
}
