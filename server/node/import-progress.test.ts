import { describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { once } from 'node:events'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
const progress = require('./import-progress.cjs')

describe('import server progress', () => {
    it('isolates imports and omits directory paths from details', () => {
        const a: any[] = [], b: any[] = []
        const offA = progress.listen('a', (row: unknown) => a.push(row))
        const offB = progress.listen('b', (row: unknown) => b.push(row))
        progress.withImportProgress('a', () => progress.reportImportProgress('stage-files', 1, 3, 'characters/private/assets/image.png'))
        expect(a.at(-1)).toMatchObject({ stage: 'stage-files', completed: 1, total: 3, detail: 'image.png' })
        expect(b).toHaveLength(0)
        offA(); offB()
    })
    it('delivers progress while synchronous import work is blocked off-thread', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-progress-work-'))
        const moduleFile = path.join(root, 'work.cjs')
        const progressFile = path.resolve(import.meta.dirname, 'import-progress.cjs')
        fs.writeFileSync(moduleFile, `
            const progress = require(${JSON.stringify(progressFile)});
            exports.run = ({ gate }) => {
                const state = new Int32Array(gate);
                progress.reportImportProgress('stage-files', 0, 2);
                while (Atomics.load(state, 0) === 0) Atomics.wait(state, 0, 0);
                progress.reportImportProgress('stage-files', 2, 2);
            };
        `)
        const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
        const releaseWork = () => {
            Atomics.store(gate, 0, 1)
            Atomics.notify(gate, 0)
        }
        const worker = new Worker(`
            const { parentPort, workerData } = require('node:worker_threads');
            const http = require('node:http');
            const progress = require(${JSON.stringify(progressFile)});
            const server = http.createServer(async (req, res) => {
                if (req.url === '/watch') return progress.stream('test', req, res);
                try {
                    await progress.withImportProgress('test', () =>
                        progress.runImportWork(workerData.moduleFile, 'run', { gate: workerData.gate }));
                    res.end('done');
                } catch (error) {
                    res.statusCode = 500;
                    res.end(error.message);
                }
            });
            server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
        `, { eval: true, workerData: { moduleFile, gate: gate.buffer } })
        const controller = new AbortController()
        let work: Promise<void> | undefined
        try {
            const [port] = await once(worker, 'message')
            // Deadlines only bound failed real HTTP I/O; synchronization uses events/Atomics.
            // Fake timers cannot control the separate Node worker's event loop.
            const response = await fetch(`http://127.0.0.1:${port}/watch`, {
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
            })
            const reader = response.body!.getReader()
            await reader.read()
            let finished = false
            work = fetch(`http://127.0.0.1:${port}/work`, { signal: AbortSignal.timeout(15000) })
                .then(async response => {
                    if (!response.ok) throw new Error(await response.text())
                    await response.text()
                    finished = true
                })
            const decoder = new TextDecoder()
            let pending = ''
            let update: { type: string; stage?: string; completed?: number } | undefined
            while (!update) {
                const { value, done } = await reader.read()
                if (done) throw new Error('Progress stream ended before the blocked import reported progress')
                pending += decoder.decode(value, { stream: true })
                const lines = pending.split('\n')
                pending = lines.pop()!
                for (const line of lines) {
                    const row = JSON.parse(line)
                    if (row.type === 'progress') update = row
                }
            }
            expect(update).toMatchObject({ stage: 'stage-files', completed: 0 })
            expect(finished).toBe(false)
            releaseWork()
            await work
            expect(finished).toBe(true)
        } finally {
            releaseWork()
            controller.abort()
            await work?.catch(() => {})
            await worker.terminate()
            fs.rmSync(root, { recursive: true, force: true })
        }
    }, 30000)
})
