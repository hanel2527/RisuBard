import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { stopChild, waitForExit, watchServerChanges } from '../../scripts/dev-launcher.mjs'

afterEach(() => vi.useRealTimers())

describe('development server lifecycle', () => {
    it('rejects an unconfirmed exit and removes its listener', async () => {
        const child = Object.assign(new EventEmitter(), {exitCode:null,signalCode:null})
        await expect(waitForExit(child, 10)).rejects.toThrow('종료')
        expect(child.listenerCount('exit')).toBe(0)
    })

    it('confirms exit instead of waiting for the deadline', async () => {
        const child = Object.assign(new EventEmitter(), {exitCode:null,signalCode:null})
        const stopped = waitForExit(child, 100)
        child.emit('exit', 0)
        await expect(stopped).resolves.toBeUndefined()
    })

    it('debounces source changes and stops watching on close', () => {
        vi.useFakeTimers()
        let changed: (event:string,file:string)=>void = () => {}
        const close = vi.fn()
        const restart = vi.fn()
        const watcher = watchServerChanges('source',restart,{delay:50,watchImpl:vi.fn((_root,_options,callback)=>{
            changed = callback
            return {close,on:vi.fn()}
        })})
        changed('change','server.cjs')
        changed('change','routes.ts')
        changed('change','cache.tmp')
        vi.advanceTimersByTime(50)
        expect(restart).toHaveBeenCalledOnce()
        changed('change','server.cjs')
        watcher.close()
        vi.advanceTimersByTime(50)
        expect(restart).toHaveBeenCalledOnce()
        expect(close).toHaveBeenCalledOnce()
    })

    it('releases the actual child before a replacement acquires the same data root', async () => {
        const root = mkdtempSync(path.join(tmpdir(),'risubard-launcher-'))
        const children: ReturnType<typeof spawn>[] = []
        const script = `require(${JSON.stringify(path.resolve('server/node/data-root-lock.cjs'))}).acquireDataRootLock(process.argv[1]);process.send('ready');setInterval(()=>{},1000)`
        try {
            for (let i=0;i<3;i++) {
                const child = spawn(process.execPath,['-e',script,root],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true})
                children.push(child)
                await new Promise<void>((resolve,reject)=>{
                    const timer = setTimeout(()=>reject(new Error('Child readiness timeout')),5000)
                    child.once('message',()=>{clearTimeout(timer);resolve()})
                    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Child exited ${code}`))})
                    child.once('error',reject)
                })
                await stopChild(child)
                expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
            }
        } finally {
            await Promise.all(children.map(child=>stopChild(child)))
            rmSync(root,{recursive:true,force:true})
        }
    })
})
