'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const context = new AsyncLocalStorage();
const tasks = new Map();
function task(id) {
    if (!tasks.has(id)) {
        for (const [key, value] of tasks) {
            if (tasks.size < 64) break;
            if (!value.listeners.size) tasks.delete(key);
        }
        tasks.set(id, { listeners: new Set(), latest: null, sentAt: 0, sentStage: '' });
    }
    return tasks.get(id);
}
function withImportProgress(id, work) { return context.run(id, work); }
function isActive() { return context.getStore() !== undefined; }
function runImportWork(moduleFile, method, input) {
    const id = context.getStore();
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'import-progress-worker.cjs'), {
            workerData: { id, moduleFile, method, input },
        });
        let outcome;
        worker.on('message', message => {
            if (message.type === 'progress') {
                if (id === undefined) return;
                const state = task(id);
                state.latest = message.row;
                for (const listener of state.listeners) {
                    try { listener(message.row); } catch {}
                }
            } else {
                outcome = message;
            }
        });
        worker.once('error', reject);
        worker.once('exit', code => {
            if (code !== 0 || !outcome) {
                reject(new Error(`Import worker exited without a result (code ${code})`));
            } else if (outcome.type === 'failure') {
                reject(Object.assign(new Error(outcome.error.message), outcome.error));
            } else {
                resolve(outcome.result);
            }
        });
    });
}
function reportImportProgress(stage, completed, total, detail) {
    const id = context.getStore();
    if (!id) return;
    const state = task(id);
    const now = Date.now();
    const row = { type: 'progress', stage, updatedAt: now };
    if (Number.isFinite(completed)) row.completed = completed;
    if (Number.isFinite(total) && total > 0) row.total = total;
    if (detail) row.detail = String(detail).split(/[\\/]/).pop().slice(0, 180);
    state.latest = row;
    if (state.sentStage === stage && now - state.sentAt < 150 && completed !== total) return;
    state.sentStage = stage;
    state.sentAt = now;
    for (const listener of state.listeners) { try { listener(row); } catch {} }
}
function listen(id, listener) {
    const state = task(id);
    state.listeners.add(listener);
    if (state.latest) listener(state.latest);
    return () => state.listeners.delete(listener);
}
function stream(id, req, res) {
    if (task(id).listeners.size >= 4 || [...tasks.values()].filter(t => t.listeners.size).length >= 32) {
        res.statusCode = 429; res.end(); return;
    }
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = row => {
        if (res.destroyed || res.writableLength > 65536) return;
        res.write(JSON.stringify(row) + '\n');
        // Import disk work runs on a separate event loop; this stream stays live.
    };
    send({ type: 'heartbeat' });
    const stop = listen(id, send);
    const timer = setInterval(() => send({ type: 'heartbeat' }), 5000);
    timer.unref?.();
    res.once('close', () => { clearInterval(timer); stop(); });
}
module.exports = { withImportProgress, reportImportProgress, listen, stream, isActive, runImportWork };
