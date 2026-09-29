import { describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
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
    it('delivers progress while a synchronous disk-work loop is still running', async () => {
        const worker = new Worker(`
            const { parentPort } = require('node:worker_threads');
            const http = require('node:http');
            const p = require(${JSON.stringify(path.resolve('server/node/import-progress.cjs'))});
            const server=http.createServer((req,res)=>{
                if(req.url==='/watch')return p.stream('test',req,res);
                p.withImportProgress('test',()=>{
                    p.reportImportProgress('stage-files',0,2);
                    const end=Date.now()+1500;while(Date.now()<end){}
                    p.reportImportProgress('stage-files',2,2);
                });res.end('done');
            });server.listen(0,'127.0.0.1',()=>parentPort.postMessage(server.address().port));
        `, { eval: true })
        try {
            const port = await new Promise<number>(resolve => worker.once('message', resolve))
            const controller = new AbortController()
            const response = await fetch(`http://127.0.0.1:${port}/watch`, { signal: controller.signal })
            const reader = response.body!.getReader()
            await reader.read() // connected, not a fabricated work update
            let finished = false
            const work = fetch(`http://127.0.0.1:${port}/work`).then(r => r.text()).then(() => { finished = true })
            const update = new TextDecoder().decode((await reader.read()).value)
            expect(update).toContain('stage-files')
            expect(finished).toBe(false)
            controller.abort()
            await work
        } finally { await worker.terminate() }
    })
})
